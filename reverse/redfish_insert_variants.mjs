import { Agent, fetch as uFetch } from 'undici';
const HOST = '192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const req = (p, o = {}) => uFetch(`https://${HOST}${p}`, { ...o, dispatcher: agent, headers: { 'content-type': 'application/json', ...(o.headers || {}) }, signal: AbortSignal.timeout(60000) });
const r = await req('/redfish/v1/SessionService/Sessions', { method: 'POST', body: JSON.stringify({ UserName: 'admin', Password: process.env.BMC_PASS || '' }) });
const h = { 'x-auth-token': r.headers.get('x-auth-token') };
const URL_BASE = '192.168.0.101:8899/test.iso';
const variants = [
  ['http + TransferProtocolType', { Image: `http://${URL_BASE}`, TransferProtocolType: 'HTTP', Inserted: true, WriteProtected: true }],
  ['https（看格式是否被接受）', { Image: `https://${URL_BASE}`, Inserted: true, WriteProtected: true }],
  ['nfs 格式', { Image: `nfs://192.168.0.101/export/test.iso`, Inserted: true, WriteProtected: true }],
  ['只给 Image（不带 Inserted）', { Image: `http://${URL_BASE}` }],
];
for (const [name, body] of variants) {
  try {
    const t0 = Date.now();
    const res = await req('/redfish/v1/Managers/Self/VirtualMedia/CD1/Actions/VirtualMedia.InsertMedia', { method: 'POST', headers: h, body: JSON.stringify(body) });
    const txt = await res.text();
    let msg = txt.slice(0, 200);
    try { const j = JSON.parse(txt); msg = j.error?.['@Message.ExtendedInfo']?.[0]?.Message || JSON.stringify(j).slice(0, 200); } catch {}
    console.log(`[${name}] → ${res.status} ${Date.now() - t0}ms | ${msg}`);
  } catch (e) {
    console.log(`[${name}] → 失败 ${e.name}`);
  }
}
try { const sess = await (await req('/redfish/v1/SessionService/Sessions', { headers: h })).json(); for (const m of sess.Members || []) await req(m['@odata.id'], { method: 'DELETE', headers: h }); console.log('会话已注销'); } catch {}
process.exit(0);
