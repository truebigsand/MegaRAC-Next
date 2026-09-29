import { Agent, fetch as uFetch } from 'undici';
const HOST = '192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const req = (p, o = {}) => uFetch(`https://${HOST}${p}`, { ...o, dispatcher: agent, headers: { 'content-type': 'application/json', ...(o.headers || {}) }, signal: AbortSignal.timeout(90000) });
const r = await req('/redfish/v1/SessionService/Sessions', { method: 'POST', body: JSON.stringify({ UserName: 'admin', Password: process.env.BMC_PASS || '' }) });
const token = r.headers.get('x-auth-token');
const h = { 'x-auth-token': token };
console.log('会话:', r.status, token ? 'ok' : '失败');
const t0 = Date.now();
const ins = await req('/redfish/v1/Managers/Self/VirtualMedia/CD1/Actions/VirtualMedia.InsertMedia', {
  method: 'POST', headers: h,
  body: JSON.stringify({ Image: 'http://192.168.0.101:8899/test.iso', Inserted: true, WriteProtected: true }),
});
console.log('InsertMedia:', ins.status, Date.now() - t0 + 'ms');
console.log('响应正文:', (await ins.text()).slice(0, 500));
const d = await (await req('/redfish/v1/Managers/Self/VirtualMedia/CD1', { headers: h })).json();
console.log('之后状态:', JSON.stringify({ Inserted: d.Inserted, Image: d.Image, ConnectedVia: d.ConnectedVia }));
try {
  const sess = await (await req('/redfish/v1/SessionService/Sessions', { headers: h })).json();
  for (const m of sess.Members || []) await req(m['@odata.id'], { method: 'DELETE', headers: h });
  console.log('会话已注销');
} catch (e) { console.log('注销失败', e.name); }
process.exit(0);
