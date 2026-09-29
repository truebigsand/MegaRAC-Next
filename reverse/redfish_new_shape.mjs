// 摸清新固件（12.61.39 / Redfish 1.8）的响应结构，尤其是我方代理依赖的字段。
import { Agent, fetch as uFetch } from 'undici';

const HOST = process.env.BMC_HOST || '192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const raw = (p, o = {}) => uFetch(`https://${HOST}${p}`, { ...o, dispatcher: agent, signal: AbortSignal.timeout(o.t || 40000) });

const r = await raw('/redfish/v1/SessionService/Sessions', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ UserName: 'admin', Password: process.env.BMC_PASS }),
});
const tok = r.headers.get('x-auth-token');
if (!tok) { console.log('Redfish 登录失败', r.status, (await r.text()).slice(0, 200)); process.exit(1); }
const H = { 'x-auth-token': tok };
console.log('Redfish 登录 OK');

const paths = [
  '/redfish/v1/Managers/Self',
  '/redfish/v1/Managers',
  '/redfish/v1/Systems',
  '/redfish/v1/Chassis',
  '/redfish/v1/Managers/Self/EthernetInterfaces',
  '/redfish/v1/SessionService',
  '/redfish/v1/AccountService/Accounts',
  '/redfish/v1/UpdateService',
  '/redfish/v1/EventService',
  '/redfish/v1/TelemetryService',
  '/redfish/v1/Managers/Self/VirtualMedia',
];
for (const p of paths) {
  const t0 = Date.now();
  try {
    const rr = await raw(p, { headers: H, t: 45000 });
    const t = await rr.text();
    console.log(`\n### ${p} → ${rr.status} (${Date.now() - t0}ms)`);
    if (rr.status === 200) {
      const d = JSON.parse(t);
      const keys = Object.keys(d);
      console.log('   顶层键:', keys.slice(0, 30).join(', '));
      for (const k of ['FirmwareVersion', 'PowerState', 'Model', 'Manufacturer', 'SerialNumber', 'ServiceEnabled', 'SessionTimeout', 'Members@odata.count', 'Status']) {
        if (k in d) console.log(`   ${k}:`, JSON.stringify(d[k]).slice(0, 200));
      }
      if (Array.isArray(d.Members)) console.log('   Members:', JSON.stringify(d.Members).slice(0, 300));
    } else {
      console.log('   ', t.slice(0, 200).replace(/\s+/g, ' '));
    }
  } catch (e) {
    console.log(`\n### ${p} → ${e.name}`);
  }
}
process.exit(0);
