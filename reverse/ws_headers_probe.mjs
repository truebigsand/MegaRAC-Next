// ⚠️ 用完务必注销：该 BMC 的 web 会话上限很小（148），泄漏会占满后
// 导致登录被拒（Maximum number of sessions already in use）且 KVM 升级被降级。
import { Agent, fetch as uFetch } from 'undici';
import { WebSocket } from 'ws';
// ⚠️ 需要 BMC 凭据：先设置环境变量 BMC_PASS 再运行
const PASS = process.env.BMC_PASS || '';
const BMC = 'https://192.168.0.200', HOST = '192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const fetch = (u, o = {}) => uFetch(u, { ...o, dispatcher: agent });
const res = await fetch(BMC + '/api/session', {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username: 'admin', password: PASS }).toString(),
});
const data = JSON.parse(await res.text());
const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
const cfg = await (await fetch(BMC + '/api/settings/media/h5viewercfg', {
  headers: { cookie, 'x-csrftoken': data.CSRFToken } })).json();
const ws = new WebSocket(`wss://${HOST}/kvm`, ['binary', 'base64'], {
  rejectUnauthorized: false, origin: BMC,
});
ws.on('upgrade', (r) => {
  console.log('=== 握手响应头 ===');
  for (const [k, v] of Object.entries(r.headers)) console.log(`${k}: ${v}`);
});
ws.on('open', () => { console.log('open, extensions =', ws.extensions); ws.close(); });
ws.on('error', (e) => console.log('error:', e.message));
setTimeout(() => process.exit(0), 5000);
