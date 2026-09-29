import { Agent, fetch as uFetch } from 'undici';
const HOST = '192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const req = (p, o = {}) => uFetch(`https://${HOST}${p}`, { ...o, dispatcher: agent, headers: { 'content-type': 'application/json', ...(o.headers || {}) }, signal: AbortSignal.timeout(40000) });
const r = await req('/redfish/v1/SessionService/Sessions', { method: 'POST', body: JSON.stringify({ UserName: 'admin', Password: process.env.BMC_PASS || '' }) });
const token = r.headers.get('x-auth-token');
if (!token) { console.log('建会话失败', r.status); process.exit(1); }
const h = { 'x-auth-token': token };
const CD = '/redfish/v1/Managers/Self/VirtualMedia/CD1';
const d = await (await req(CD, { headers: h })).json();
console.log('CD1 现状:', JSON.stringify({ Inserted: d.Inserted, Image: d.Image, ConnectedVia: d.ConnectedVia, ImageName: d.ImageName }));
if (process.argv[2] === 'eject') {
  const ej = await req(`${CD}/Actions/VirtualMedia.EjectMedia`, { method: 'POST', headers: h, body: '{}' });
  console.log('EjectMedia →', ej.status, (await ej.text()).slice(0, 120));
  await new Promise((s) => setTimeout(s, 4000));
  const d2 = await (await req(CD, { headers: h })).json();
  console.log('弹出后:', JSON.stringify({ Inserted: d2.Inserted, Image: d2.Image }));
}
const sess = await (await req('/redfish/v1/SessionService/Sessions', { headers: h })).json();
for (const m of sess.Members || []) { await req(m['@odata.id'], { method: 'DELETE', headers: h }); }
console.log('会话已注销');
process.exit(0);
