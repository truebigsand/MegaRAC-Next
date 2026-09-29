import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { randomUUID } from 'node:crypto';
import { BmcSessionExpiredError } from './bmc.js';
import {
  acquireClient, createSession, dropSession, getSession, hasSessionFor,
  releaseClient, sessionCount, allSessions,
} from './sessions.js';
import { SqliteHistoryStore } from './history/sqlite.js';
import { HistorySampler } from './history/sampler.js';
import { registerKvm, closeAllKvm } from './kvm-route.js';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 5177);
const COOKIE_NAME = 'mn_token';
const HISTORY_DB = process.env.HISTORY_DB || 'data/history.sqlite3';

const app = Fastify({
  logger: { level: 'info', transport: undefined },
});

await app.register(cookie);

// 容忍空 body 的 JSON 请求（例如不带内容的 DELETE），避免 FST_ERR_CTP_EMPTY_JSON_BODY
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  const text = String(body ?? '').trim();
  if (text === '') return done(null, undefined);
  try {
    done(null, JSON.parse(text));
  } catch (e) {
    done(e as Error, undefined);
  }
});

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
  // 同账号复用一个 BMC 会话（见 sessions.ts 的说明：BMC 会话表小且同账号互踢）
  const client = acquireClient(username, password);
  try {
    if (!client.loggedIn) await client.login();
  } catch (e) {
    releaseClient(username);
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
  app.log.info(
    `浏览器会话建立 (BMC racsession_id=${client.sessionId})，浏览器会话数=${sessionCount()}（BMC 侧共享 1 条）`,
  );
  return { ok: true, username: client.username };
});

app.post('/api/auth/logout', async (req, reply) => {
  const token = req.cookies[COOKIE_NAME];
  if (token) {
    const session = dropSession(token);
    if (session) {
      // 只有该账号已无其它浏览器会话时才真正注销 BMC 会话，否则别人的页面会被踢下线
      if (!hasSessionFor(session.client.username)) {
        releaseClient(session.client.username);
        await session.client.logout();
      }
      app.log.info(
        `浏览器会话注销 (BMC racsession_id=${session.client.sessionId})，` +
          `浏览器会话数=${sessionCount()}，BMC 侧仍在线=${hasSessionFor(session.client.username)}`,
      );
    }
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
      // BMC 会话失效且自动重登失败：同时丢弃浏览器会话，
      // 否则 /api/auth/me 仍回答已登录，前端会在登录页与主页之间反复跳转
      const token = req.cookies[COOKIE_NAME];
      if (token && dropSession(token)) {
        app.log.warn('BMC 会话失效且重登失败，已丢弃浏览器会话（需重新登录）');
      }
      return reply.code(401).send({ error: 'bmc_session_expired' });
    }
    app.log.error(`BMC GET 失败 ${path}: ${(e as Error).message}`);
    return reply.code(502).send({ error: 'bmc_unreachable', detail: (e as Error).message });
  }
});

// ---------- BMC 写操作通道 ----------

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
      // BMC 会话失效且自动重登失败：同时丢弃浏览器会话，
      // 否则 /api/auth/me 仍回答已登录，前端会在登录页与主页之间反复跳转
      const token = req.cookies[COOKIE_NAME];
      if (token && dropSession(token)) {
        app.log.warn('BMC 会话失效且重登失败，已丢弃浏览器会话（需重新登录）');
      }
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

// ---------- BMC 会话维护 ----------

/**
 * 清理 BMC 上的**其它**会话（保留本代理正在用的那条）。
 *
 * 用途：该 BMC 的会话表只有 148 格，且实测脚本/多标签页很容易把它占满——
 * 满了以后新登录直接被拒（`Maximum number of sessions already in use`），
 * 连 KVM 的 WebSocket 升级都会被降级成一个 HTTP 回退响应。
 * 这个端点让用户能在 UI 上一键把僵尸会话清掉，不必重启 BMC。
 *
 * 只删会话记录，不动任何配置。
 */
app.post('/api/maintenance/clear-bmc-sessions', async (req, reply) => {
  const session = getSession(req.cookies[COOKIE_NAME]);
  if (!session) return reply.code(401).send({ error: 'not_logged_in' });
  const mine = session.client.sessionId;
  // 一次取全部会话再按类型分组（实测带 service_type 查询参数会被忽略/返回空）
  const res = await session.client.get('/api/settings/service-sessions');
  const all = (Array.isArray(res.body) ? res.body : []) as {
    session_id?: number;
    id?: number;
    session_type?: number;
    user_name?: string;
    client_ip?: string;
  }[];
  const typeName: Record<number, string> = {
    1: 'web',
    2: 'kvm',
    5: 'kvm',
    3: 'cd-media',
    4: 'hd-media',
    6: 'ssh',
  };
  const report: Record<string, { total: number; removed: number; failed: number }> = {};
  const errors: number[] = [];
  for (const e of all) {
    const id = e.session_id ?? e.id;
    const kind = typeName[e.session_type ?? -1] ?? `type${e.session_type ?? '?'}`;
    const stat = (report[kind] ??= { total: 0, removed: 0, failed: 0 });
    stat.total++;
    if (id === undefined || id === mine) continue; // 别把自己踢下线
    const del = await session.client.send('DELETE', `/api/settings/service-sessions/${id}`);
    if (del.status === 200 || del.status === 204) stat.removed++;
    else stat.failed++;
  }
  app.log.warn(`清理 BMC 会话：${JSON.stringify(report)}（保留本代理会话 id=${mine}）`);
  return { ok: true, kept: mine, report };
});

// ---------- KVM ----------

await registerKvm(app);

app.listen({ host: HOST, port: PORT }).then(() => {
  app.log.info(`MegaRAC-Next 代理已启动 http://${HOST}:${PORT}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    // 退出前主动释放 KVM 主控，否则会在 BMC 侧留下占用会话槽的僵尸
    closeAllKvm();
    process.exit(0);
  });
}
