import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { randomUUID } from 'node:crypto';
import { BmcClient, BmcSessionExpiredError } from './bmc.js';
import { createSession, dropSession, getSession, sessionCount, allSessions } from './sessions.js';
import { SqliteHistoryStore } from './history/sqlite.js';
import { HistorySampler } from './history/sampler.js';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 5177);
const COOKIE_NAME = 'mn_token';
const HISTORY_DB = process.env.HISTORY_DB || 'data/history.sqlite3';

const app = Fastify({
  logger: { level: 'info', transport: undefined },
});

await app.register(cookie);

// ---------- 传感器历史（接口化存储，默认 SQLite） ----------
const historyStore = new SqliteHistoryStore(HISTORY_DB);
await historyStore.init();
const sampler = new HistorySampler(historyStore);
sampler.start(() => {
  // 借用任一活跃浏览器会话的 BMC 客户端；无登录会话则本轮跳过
  for (const s of allSessions()) return s.client;
  return null;
});

// ---------- 历史查询 API ----------
app.get('/api/history/sensors', async () => {
  return { sensors: await historyStore.sensors() };
});

app.get('/api/history', async (req) => {
  const q = req.query as { sensor?: string; minutes?: string };
  if (!q.sensor) return reply0BadRequest('需要 sensor 参数');
  const minutes = Math.min(Math.max(Number(q.minutes) || 60, 1), 60 * 24 * 31);
  const points = await historyStore.query(q.sensor, Date.now() - minutes * 60_000);
  return { sensor: q.sensor, minutes, points };
});

function reply0BadRequest(msg: string) {
  const err = new Error(msg) as Error & { statusCode?: number };
  err.statusCode = 400;
  throw err;
}

app.addHook('onRequest', async (req, reply) => {
  if (req.url.startsWith('/bmc/')) {
    const session = getSession(req.cookies[COOKIE_NAME]);
    if (!session) {
      return reply.code(401).send({ error: 'not_logged_in' });
    }
  }
});

// ---------- 认证 ----------

app.post('/api/auth/login', async (req, reply) => {
  const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
  if (!username || !password) {
    return reply.code(400).send({ error: '需要 username 与 password' });
  }
  const client = new BmcClient(username, password);
  try {
    await client.login();
  } catch (e) {
    app.log.warn(`BMC 登录失败: ${(e as Error).message}`);
    return reply.code(401).send({ error: (e as Error).message });
  }
  const token = randomUUID();
  createSession(token, client);
  reply.setCookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
  });
  app.log.info(`浏览器会话建立 (BMC racsession_id=${client.sessionId})，当前会话数=${sessionCount()}`);
  return { ok: true, username: client.username };
});

app.post('/api/auth/logout', async (req, reply) => {
  const token = req.cookies[COOKIE_NAME];
  if (token) {
    const session = dropSession(token);
    await session?.client.logout();
    app.log.info(`会话注销 (BMC racsession_id=${session?.client.sessionId})，当前会话数=${sessionCount()}`);
  }
  reply.clearCookie(COOKIE_NAME, { path: '/' });
  return { ok: true };
});

app.get('/api/auth/me', async (req) => {
  const session = getSession(req.cookies[COOKIE_NAME]);
  if (!session) return { loggedIn: false };
  return { loggedIn: true, username: session.client.username };
});

// ---------- BMC 数据代理（只读） ----------

app.get('/bmc/*', async (req, reply) => {
  const { ['*']: path } = req.params as { '*': string };
  const qs = req.url.includes('?') ? '?' + req.url.split('?')[1] : '';
  const session = getSession(req.cookies[COOKIE_NAME])!;
  try {
    const res = await session.client.get('/api/' + path + qs);
    if (res.body !== null) return reply.code(res.status).send(res.body);
    return reply.code(res.status).type('application/json').send(res.text);
  } catch (e) {
    if (e instanceof BmcSessionExpiredError) {
      return reply.code(401).send({ error: 'bmc_session_expired' });
    }
    app.log.error(`BMC GET 失败 ${path}: ${(e as Error).message}`);
    return reply.code(502).send({ error: 'bmc_unreachable', detail: (e as Error).message });
  }
});

// ---------- BMC 写操作通道（已实现；前端在验证完成前不接通） ----------

async function forwardWrite(
  req: import('fastify').FastifyRequest,
  reply: import('fastify').FastifyReply,
  method: 'POST' | 'PUT' | 'DELETE',
) {
  const { ['*']: path } = req.params as { '*': string };
  const session = getSession(req.cookies[COOKIE_NAME])!;
  try {
    const res = await session.client.send(method, '/api/' + path, req.body ?? undefined);
    if (res.body !== null) return reply.code(res.status).send(res.body);
    return reply.code(res.status).type('application/json').send(res.text);
  } catch (e) {
    if (e instanceof BmcSessionExpiredError) {
      return reply.code(401).send({ error: 'bmc_session_expired' });
    }
    app.log.error(`BMC ${method} 失败 ${path}: ${(e as Error).message}`);
    return reply.code(502).send({ error: 'bmc_unreachable', detail: (e as Error).message });
  }
}

app.post('/bmc/*', (req, reply) => forwardWrite(req, reply, 'POST'));
app.put('/bmc/*', (req, reply) => forwardWrite(req, reply, 'PUT'));
app.delete('/bmc/*', (req, reply) => forwardWrite(req, reply, 'DELETE'));

// ---------- 健康检查 ----------

app.get('/api/health', async () => ({ ok: true, browserSessions: sessionCount() }));

app.listen({ host: HOST, port: PORT }).then(() => {
  app.log.info(`MegaRAC-Next 代理已启动 http://${HOST}:${PORT}`);
});
