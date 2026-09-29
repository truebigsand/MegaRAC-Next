// 上传失败后的状态诊断：等 BMC 缓过来，再看它怎么描述这次失败。
import { Agent, fetch as uFetch } from 'undici';

const HOST = process.env.BMC_HOST || '192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const raw = (p, o = {}) => uFetch(`https://${HOST}${p}`, { ...o, dispatcher: agent, signal: AbortSignal.timeout(o.t || 45000) });
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let login = {}, cookie = '';
for (let i = 1; i <= 25; i++) {
  try {
    const lr = await raw('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: process.env.BMC_PASS }).toString(),
    });
    const t = await lr.text();
    try { login = JSON.parse(t); } catch { login = {}; }
    if (lr.status === 200 && login.ok === 0) {
      cookie = (lr.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
      log('已登录');
      break;
    }
    log(`登录 ${lr.status} ${t.slice(0, 90)} —— 等 15s`);
  } catch (e) {
    log(`登录异常 ${e.name} —— 等 15s`);
  }
  await sleep(15000);
}
if (!cookie) { log('始终无法登录'); process.exit(1); }
const H = { cookie, 'X-CSRFTOKEN': login.CSRFToken, 'X-Requested-With': 'XMLHttpRequest' };

const paths = [
  '/api/maintenance/firmware/verification?flash_type=BMC',
  '/api/maintenance/firmware/flash-progress',
  '/api/maintenance/fwupdate_check',
  '/api/maintenance/hpm/freemem',
  '/api/logs/audit?start=0&count=15',
];
for (const p of paths) {
  const t0 = Date.now();
  try {
    const r = await raw(p, { headers: H, t: 50000 });
    const x = await r.text();
    log(`### ${p} → ${r.status} ${Date.now() - t0}ms`);
    console.log('   ', x.slice(0, 900).replace(/\s+/g, ' '));
  } catch (e) {
    log(`### ${p} → ${e.name}`);
  }
}
process.exit(0);
