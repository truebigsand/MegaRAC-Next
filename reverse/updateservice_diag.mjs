// 诊断：UpdateService 资源为何挂起，以及挂起是否影响同会话其他请求。
import { Agent, fetch as uFetch } from 'undici';
const HOST = '192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const req = (p, o = {}) =>
  uFetch(`https://${HOST}${p}`, { ...o, dispatcher: agent, headers: { 'content-type': 'application/json', ...(o.headers || {}) }, signal: AbortSignal.timeout(o.t || 20000) });

const r = await req('/redfish/v1/SessionService/Sessions', { method: 'POST', body: JSON.stringify({ UserName: 'admin', Password: process.env.BMC_PASS }) });
const tok = r.headers.get('x-auth-token');
console.log('登录:', r.status, tok ? 'OK ✓' : '✗ ' + (await r.text()).slice(0, 200));
if (!tok) process.exit(1);
const h = { 'x-auth-token': tok };

const probe = async (p, t = 20000) => {
  const t0 = Date.now();
  try {
    const rr = await req(p, { headers: h, t });
    const txt = await rr.text();
    console.log(`  ${p}\n      → ${rr.status} ${Date.now() - t0}ms  ${txt.slice(0, 160).replace(/\s+/g, ' ')}`);
    return { status: rr.status, txt, ms: Date.now() - t0 };
  } catch (e) {
    console.log(`  ${p}\n      → ${e.name} ${Date.now() - t0}ms`);
    return { status: 0, txt: '', ms: Date.now() - t0 };
  }
};

console.log('--- 基线：其他资源正常否 ---');
await probe('/redfish/v1/Managers/Self');
await probe('/redfish/v1/Chassis');
await probe('/redfish/v1/Systems/1');
await probe('/redfish/v1/UpdateService/FirmwareInventory');
await probe('/redfish/v1/UpdateService/FirmwareInventory/BMC');
console.log('--- UpdateService 本体（可能挂起）---');
await probe('/redfish/v1/UpdateService', 45000);
console.log('--- 挂起之后：会话还活着吗 ---');
await probe('/redfish/v1/Managers/Self');
await probe('/redfish/v1/UpdateService/SimpleUpdateActionInfo');
console.log('--- 经典 web 侧同一资源 ---');
const login = await req('/api/session', { method: 'POST', body: JSON.stringify({ username: 'admin', password: process.env.BMC_PASS }) });
console.log('  /api/session →', login.status);
const ck = (login.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
if (ck) {
  const a = await req('/redfish/v1/UpdateService/SimpleUpdateActionInfo', { headers: { cookie: ck } }).catch((e) => ({ status: 0, text: async () => e.name }));
  console.log('  经典会话查 ActionInfo →', a.status, String(await a.text()).slice(0, 160));
  await req('/api/session', { method: 'DELETE', headers: { cookie: ck } }).catch(() => {});
}
process.exit(0);
