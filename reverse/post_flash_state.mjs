import { Agent, fetch as uFetch } from 'undici';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const req = (p, o = {}) => uFetch(`https://192.168.0.200${p}`, { ...o, dispatcher: agent, headers: { 'content-type': 'application/json', ...(o.headers || {}) }, signal: AbortSignal.timeout(o.t || 25000) });
const r = await req('/redfish/v1/SessionService/Sessions', { method: 'POST', body: JSON.stringify({ UserName: 'admin', Password: process.env.BMC_PASS }) });
const tok = r.headers.get('x-auth-token');
console.log('登录:', r.status, tok ? 'OK' : 'FAIL');
if (!tok) { console.log((await r.text()).slice(0, 300)); process.exit(1); }
const h = { 'x-auth-token': tok };
const probe = async (p, t) => {
  const t0 = Date.now();
  try { const rr = await req(p, { headers: h, t }); const txt = await rr.text();
    console.log(`${p}\n   ${rr.status} ${Date.now() - t0}ms  ${txt.slice(0, 300).replace(/\s+/g, ' ')}`); return txt; }
  catch (e) { console.log(`${p}\n   ${e.name} ${Date.now() - t0}ms`); return ''; }
};
console.log('--- 任务列表 ---');
const tasks = await probe('/redfish/v1/TaskService/Tasks');
try {
  const d = JSON.parse(tasks);
  for (const m of d.Members || []) {
    const t = await probe(m['@odata.id'], 20000);
    try { const td = JSON.parse(t); console.log('     TaskState=', td.TaskState, 'Percent=', td.PercentComplete); } catch {}
  }
} catch {}
console.log('--- 当前版本 / 更新服务 ---');
const m = await probe('/redfish/v1/Managers/Self');
try { const d = JSON.parse(m); console.log('     版本:', d.FirmwareVersion, d.Status?.State); } catch {}
await probe('/redfish/v1/UpdateService', 30000);
console.log('--- 经典 web 侧是否在刷写模式 ---');
const login = await req('/api/session', { method: 'POST', body: JSON.stringify({ username: 'admin', password: process.env.BMC_PASS }), headers: { 'X-Requested-With': 'XMLHttpRequest' } });
console.log('/api/session →', login.status);
process.exit(0);
