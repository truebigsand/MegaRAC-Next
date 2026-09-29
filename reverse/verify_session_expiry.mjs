// 用本地假 BMC 验证代理的会话失效处理：
//  - GET /api/* 返回 401 {"cc":7,"error":"Invalid Authentication"}（模拟会话失效）
//    → 代理应尝试静默重登、仍失败则丢弃「浏览器会话」，使 /api/auth/me 变为未登录
//  - GET /api/kvm-like 返回 403（模拟资源性拒绝）
//    → 代理应原样返回 403，且不得丢弃浏览器会话
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const STUB = 5199;
const PROXY = 5178;

// ---- 假 BMC ----
const stub = createServer((req, res) => {
  const url = req.url ?? '';
  if (req.method === 'POST' && url.startsWith('/api/session')) {
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'stub=1; Path=/' });
    return res.end(JSON.stringify({ ok: 0, privilege: 4, racsession_id: 1, CSRFToken: 'STUB', passwordStatus: 0 }));
  }
  if (url.startsWith('/api/forbidden')) {
    res.writeHead(403, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ cc: 1, error: 'KVM session slots full' }));
  }
  if (url.startsWith('/api/')) {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ cc: 7, error: 'Invalid Authentication' }));
  }
  res.writeHead(404).end('{}');
});
await new Promise((r) => stub.listen(STUB, '127.0.0.1', r));

// ---- 代理（指向假 BMC）----
const tsxCli = 'node_modules/tsx/dist/cli.mjs';
const proxy = spawn(process.execPath, [tsxCli, 'server/src/index.ts'], {
  cwd: process.cwd(),
  env: { ...process.env, BMC_BASE: `http://127.0.0.1:${STUB}`, PORT: String(PROXY), HOST: '127.0.0.1', HISTORY_DB: 'data/_test_history.sqlite3' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let proxyLog = '';
proxy.stdout.on('data', (d) => (proxyLog += d.toString()));
proxy.stderr.on('data', (d) => (proxyLog += d.toString()));
await new Promise((r) => setTimeout(r, 4000));

const base = `http://127.0.0.1:${PROXY}`;
let cookie = '';
async function call(method, path, body) {
  const h = {};
  if (cookie) h.cookie = cookie;
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  return { status: res.status, text: text.slice(0, 120) };
}

try {
  const health = await fetch(base + '/api/health').catch(() => null);
  if (!health) { console.log('代理未启动，日志：'); console.log(proxyLog.slice(-1500)); process.exit(1); }
  console.log('登录:', (await call('POST', '/api/auth/login', { username: 'admin', password: 'x' })).status);
  console.log('登录后 /api/auth/me:', (await call('GET', '/api/auth/me')).text);
  console.log('会话失效的 /bmc 请求:', JSON.stringify(await call('GET', '/bmc/chassis-status')));
  console.log('此后 /api/auth/me（应为未登录）:', (await call('GET', '/api/auth/me')).text);

  console.log('\n--- 403 不应导致登出 ---');
  cookie = '';
  console.log('重新登录:', (await call('POST', '/api/auth/login', { username: 'admin', password: 'x' })).status);
  console.log('资源性 403 请求:', JSON.stringify(await call('GET', '/bmc/forbidden')));
  console.log('此后 /api/auth/me（应仍为已登录）:', (await call('GET', '/api/auth/me')).text);
} finally {
  proxy.kill();
  stub.close();
}
