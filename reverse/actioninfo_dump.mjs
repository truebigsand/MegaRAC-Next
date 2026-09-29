import { Agent, fetch as uFetch } from 'undici';
import fs from 'node:fs';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const req = (p, o = {}) => uFetch(`https://192.168.0.200${p}`, { ...o, dispatcher: agent, headers: { 'content-type': 'application/json', ...(o.headers || {}) }, signal: AbortSignal.timeout(30000) });
const r = await req('/redfish/v1/SessionService/Sessions', { method: 'POST', body: JSON.stringify({ UserName: 'admin', Password: process.env.BMC_PASS }) });
const h = { 'x-auth-token': r.headers.get('x-auth-token') };
const res = await req('/redfish/v1/UpdateService/SimpleUpdateActionInfo', { headers: h });
const txt = await res.text();
fs.writeFileSync('reverse/out_actioninfo.json', txt);
console.log('HTTP', res.status, '已存 reverse/out_actioninfo.json');
const d = JSON.parse(txt);
console.log('Target:', d.Target);
console.log('Parameters:');
for (const p of d.Parameters || []) {
  console.log(`  * ${p.Name}  Required=${p.Required}  Type=${p.DataType}  Allowable=${JSON.stringify(p.AllowableValues || [])}`);
}
process.exit(0);
