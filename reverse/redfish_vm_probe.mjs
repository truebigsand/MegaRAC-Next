import { Agent, fetch as uFetch } from 'undici';
const HOST = '192.168.0.200', USER = 'admin', PASS = process.env.BMC_PASS || '';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const req = (p, o = {}) => uFetch(`https://${HOST}${p}`, { ...o, dispatcher: agent, headers: { 'content-type': 'application/json', ...(o.headers || {}) }, signal: AbortSignal.timeout(25000) });
const r = await req('/redfish/v1/SessionService/Sessions', { method: 'POST', body: JSON.stringify({ UserName: USER, Password: PASS }) });
const token = r.headers.get('x-auth-token');
const h = { 'x-auth-token': token };
const cd = await req('/redfish/v1/Managers/Self/VirtualMedia/CD1', { headers: h });
console.log('CD1:', cd.status);
console.log(JSON.stringify(await cd.json(), null, 1).slice(0, 1200));
const sess = await req('/redfish/v1/SessionService/Sessions', { headers: h });
const d = await sess.json();
for (const m of d.Members || []) { if (m['@odata.id']) { const del = await req(m['@odata.id'], { method: 'DELETE', headers: h }); console.log('注销', m['@odata.id'], del.status); } }
process.exit(0);
