// Redfish 虚拟介质实测：让 BMC 自己从 HTTP 拉一个 ISO 并挂到主机上。
// 这条路径与浏览器端的 iusb 重定向完全无关（BMC 主动拉取，客户端可断开）。
// 用完立即弹出（Eject），不留状态。
import { Agent, fetch as uFetch } from 'undici';

const HOST = process.env.BMC_HOST || '192.168.0.200';
const IMAGE = process.env.IMG_URL || 'http://192.168.0.101:8899/test.iso';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const req = (p, o = {}) =>
  uFetch(`https://${HOST}${p}`, {
    ...o,
    dispatcher: agent,
    headers: { 'content-type': 'application/json', ...(o.headers || {}) },
    signal: AbortSignal.timeout(30000),
  });

const r = await req('/redfish/v1/SessionService/Sessions', {
  method: 'POST',
  body: JSON.stringify({ UserName: process.env.BMC_USER || 'admin', Password: process.env.BMC_PASS || '' }),
});
const token = r.headers.get('x-auth-token');
if (!token) {
  console.log('建会话失败:', r.status, (await r.text()).slice(0, 120));
  process.exit(1);
}
const h = { 'x-auth-token': token };
const CD = '/redfish/v1/Managers/Self/VirtualMedia/CD1';

const state = async () => {
  const d = await (await req(CD, { headers: h })).json();
  return { Inserted: d.Inserted, Image: d.Image, ConnectedVia: d.ConnectedVia, WriteProtected: d.WriteProtected };
};
console.log('挂载前:', JSON.stringify(await state()));

const ins = await req(`${CD}/Actions/VirtualMedia.InsertMedia`, {
  method: 'POST',
  headers: h,
  body: JSON.stringify({ Image: IMAGE, Inserted: true, WriteProtected: true }),
});
console.log(`InsertMedia ${IMAGE} →`, ins.status, (await ins.text()).slice(0, 300));
await new Promise((s) => setTimeout(s, 4000));
console.log('挂载后:', JSON.stringify(await state()));

// 看看 BMC 侧的介质状态接口是否也认了
const ac = await req('/redfish/v1/Managers/Self/VirtualMedia', { headers: h });
console.log('VirtualMedia 集合:', ac.status);

// 弹出，恢复原状
const ej = await req(`${CD}/Actions/VirtualMedia.EjectMedia`, { method: 'POST', headers: h, body: '{}' });
console.log('EjectMedia →', ej.status, (await ej.text()).slice(0, 160));
await new Promise((s) => setTimeout(s, 3000));
console.log('弹出后:', JSON.stringify(await state()));

const sess = await (await req('/redfish/v1/SessionService/Sessions', { headers: h })).json();
for (const m of sess.Members || []) {
  console.log('注销', m['@odata.id'], (await req(m['@odata.id'], { method: 'DELETE', headers: h })).status);
}
process.exit(0);
