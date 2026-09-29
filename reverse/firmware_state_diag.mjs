// 通过经典 web API 查看 BMC 当前的固件/刷写状态。
// 目的：Redfish SimpleUpdate 的 POST 挂起且不建任务，需要判断 BMC 是否自认为「正在刷写」。
import { Agent, fetch as uFetch } from 'undici';

const HOST = process.env.BMC_HOST || '192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const raw = (p, o = {}) =>
  uFetch(`https://${HOST}${p}`, { ...o, dispatcher: agent, signal: AbortSignal.timeout(o.timeoutMs || 30000) });

const lr = await raw('/api/session', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username: process.env.BMC_USER || 'admin', password: process.env.BMC_PASS || '' }).toString(),
});
const login = await lr.json().catch(() => ({}));
console.log('经典登录:', lr.status, JSON.stringify(login).slice(0, 200));
if (lr.status !== 200 || login.ok !== 0) process.exit(1);
const cookie = (lr.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
const h = { cookie, 'x-csrftoken': login.CSRFToken };

const show = async (path, method = 'GET', body) => {
  const t0 = Date.now();
  try {
    const r = await raw(path, {
      method,
      headers: { ...h, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      timeoutMs: 45000,
    });
    const txt = await r.text();
    console.log(`\n### ${method} ${path} → ${r.status} (${Date.now() - t0}ms)`);
    console.log('    ', txt.slice(0, 900).replace(/\s+/g, ' '));
    return txt;
  } catch (e) {
    console.log(`\n### ${method} ${path} → ${e.name} (${Date.now() - t0}ms)`);
    return '';
  }
};

await show('/api/maintenance/firmware');
await show('/api/maintenance/firmware/flash-progress');
await show('/api/maintenance/flash');
await show('/api/maintenance/hpm/componentversions');
await show('/api/maintenance/hpm/freemem');

// 注销经典会话
await raw('/api/session', { method: 'DELETE', headers: h }).catch(() => {});
console.log('\n经典会话已注销');
process.exit(0);
