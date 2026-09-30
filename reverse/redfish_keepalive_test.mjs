// 验证一个假设：BMC 的 Redfish 在 HTTP keep-alive 复用连接时会认不出会话
// （表现为：同一连接上第一个请求成功、后续 401 "the service was denied access"）。
// 三组对照：A 默认复用 / B 每次 connection: close / C 每次新建 Agent。
import { Agent, fetch as uFetch } from 'undici';

const HOST = process.env.BMC_HOST || '192.168.0.200';
const PATHS = ['/redfish/v1/Systems', '/redfish/v1/Chassis', '/redfish/v1/UpdateService', '/redfish/v1/AccountService/Accounts', '/redfish/v1/EventService', '/redfish/v1/TelemetryService'];

const login = async (agent) => {
  const r = await uFetch(`https://${HOST}/redfish/v1/SessionService/Sessions`, {
    method: 'POST', dispatcher: agent, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ UserName: 'admin', Password: process.env.BMC_PASS }),
    signal: AbortSignal.timeout(30000),
  });
  return r.headers.get('x-auth-token');
};

const run = async (label, makeAgent, extraHeaders = {}) => {
  const agent = makeAgent();
  const tok = await login(agent);
  if (!tok) { console.log(`${label}: 登录失败`); return; }
  const codes = [];
  for (const p of PATHS) {
    try {
      const r = await uFetch(`https://${HOST}${p}`, { dispatcher: agent, headers: { 'x-auth-token': tok, ...extraHeaders }, signal: AbortSignal.timeout(25000) });
      await r.text();
      codes.push(r.status);
    } catch (e) { codes.push(e.name === 'TimeoutError' ? 'TO' : 'ERR'); }
  }
  console.log(`${label}: ${codes.join(' ')}   （200 占比 ${codes.filter((c) => c === 200).length}/${codes.length}）`);
  await uFetch(`https://${HOST}/redfish/v1/SessionService/Sessions/${tok}`, { method: 'DELETE', dispatcher: agent, headers: { 'x-auth-token': tok } }).catch(() => {});
};

// A) 默认：连接复用
await run('A 默认复用      ', () => new Agent({ connect: { rejectUnauthorized: false } }));
// B) 每次请求要求关闭连接
await run('B Connection:close', () => new Agent({ connect: { rejectUnauthorized: false } }), { connection: 'close' });
// C) 每次请求新建连接池（不复用）
await run('C 每请求新 Agent ', () => new Agent({ connect: { rejectUnauthorized: false }, pipelining: 0, connections: 1, keepAliveTimeout: 1 }));
// D) 再跑一次 A，看是否稳定复现
await run('D 默认复用(复现)', () => new Agent({ connect: { rejectUnauthorized: false } }));
process.exit(0);
