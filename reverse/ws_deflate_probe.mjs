// ⚠️ 用完务必注销：该 BMC 的 web 会话上限很小（148），泄漏会占满后
// 导致登录被拒（Maximum number of sessions already in use）且 KVM 升级被降级。
// BMC 的 /kvm 会在**未协商** permessage-deflate 的情况下发出 RSV1(压缩) 帧，
// 导致 ws 报 "Invalid WebSocket frame: RSV1 must be clear"。
// 这里试几种扩展 offer，看 BMC 是否会回显 sec-websocket-extensions（回显则 ws 能正常解压）。
import { Agent, fetch as uFetch } from 'undici';
import { WebSocket } from 'ws';
// ⚠️ 需要 BMC 凭据：先设置环境变量 BMC_PASS 再运行
const PASS = process.env.BMC_PASS || '';

const BMC = 'https://192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const fetch = (u, o = {}) => uFetch(u, { ...o, dispatcher: agent });

async function login() {
  const res = await fetch(BMC + '/api/session', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: PASS }).toString(),
  });
  const data = JSON.parse(await res.text());
  return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
}

const cookie = await login();
const variants = [
  ['默认（客户端默认的 permessage-deflate 报价）', { perMessageDeflate: true }],
  ['permessage-deflate 纯净报价', { perMessageDeflate: {} }],
  ['server_no_context_takeover', { perMessageDeflate: { serverNoContextTakeover: true } }],
  ['完全不带扩展', { perMessageDeflate: false }],
];

for (const [name, opts] of variants) {
  const res = await new Promise((resolve) => {
    const ws = new WebSocket(`wss://192.168.0.200/kvm`, ['binary', 'base64'], {
      rejectUnauthorized: false, origin: BMC, headers: { Cookie: cookie }, ...opts,
    });
    const out = { name, extHeader: null, negotiated: null, frames: 0, err: null };
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(out); }, 6000);
    ws.on('upgrade', (r) => { out.extHeader = r.headers['sec-websocket-extensions'] ?? '(无)'; });
    ws.on('open', () => { out.negotiated = ws.extensions || '(空)'; });
    ws.on('message', () => { out.frames++; });
    ws.on('error', (e) => { out.err = e.message; });
    ws.on('close', () => { clearTimeout(timer); resolve(out); });
  });
  console.log(`\n【${name}】`);
  console.log(`  响应 sec-websocket-extensions: ${res.extHeader}`);
  console.log(`  ws 认定的扩展: ${res.negotiated}`);
  console.log(`  收到帧数: ${res.frames}${res.err ? '  错误: ' + res.err : ''}`);
  await new Promise((r) => setTimeout(r, 1200));
}
process.exit(0);
