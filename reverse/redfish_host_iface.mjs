import { Agent, fetch as uFetch } from 'undici';
const HOST = '192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const req = (p, o = {}) => uFetch(`https://${HOST}${p}`, { ...o, dispatcher: agent, headers: { 'content-type': 'application/json', ...(o.headers || {}) }, signal: AbortSignal.timeout(60000) });
const r = await req('/redfish/v1/SessionService/Sessions', { method: 'POST', body: JSON.stringify({ UserName: 'admin', Password: process.env.BMC_PASS || '' }) });
const h = { 'x-auth-token': r.headers.get('x-auth-token') };
for (const p of ['/redfish/v1/Managers/Self/HostInterfaces', '/redfish/v1/Managers/Self/EthernetInterfaces']) {
  try {
    const res = await req(p, { headers: h });
    const t = await res.text();
    console.log(`\n${p} -> ${res.status}`);
    if (res.status === 200) {
      const d = JSON.parse(t);
      console.log('  Members:', (d.Members || []).map((m) => m['@odata.id']));
      console.log('  条数:', d['Members@odata.count']);
      for (const m of (d.Members || []).slice(0, 3)) {
        const dd = await (await req(m['@odata.id'], { headers: h })).json();
        console.log('   ', JSON.stringify({ Id: dd.Id, Name: dd.Name, InterfaceEnabled: dd.InterfaceEnabled, Type: dd.InterfaceType, IPv4: dd.IPv4Addresses?.[0]?.Address, ExternallyAccessible: dd.ExternallyAccessible, DHCP: dd.DHCPv4?.DHCPEnabled }));
      }
    } else console.log('  正文:', t.slice(0, 150));
  } catch (e) { console.log(`\n${p} -> 失败 ${e.name}`); }
}
try { const s = await (await req('/redfish/v1/SessionService/Sessions', { headers: h })).json(); for (const m of s.Members || []) await req(m['@odata.id'], { method: 'DELETE', headers: h }); console.log('\n会话已注销'); } catch {}
process.exit(0);
