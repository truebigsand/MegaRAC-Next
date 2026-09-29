// 探测 BMC 的本地介质重定向通道 /cd-server 是否可用（决定虚拟介质走哪条路）。
// ⚠️ 用完务必注销：该 BMC 的 web 会话表很小（148），泄漏会占满。
import tls from 'node:tls';
import { Agent, fetch as uFetch } from 'undici';
// ⚠️ 需要 BMC 凭据：先设置环境变量 BMC_PASS 再运行
const PASS = process.env.BMC_PASS || '';

const HOST = '192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const fetch = (u, o = {}) => uFetch(u, { ...o, dispatcher: agent });

const res = await fetch('https://' + HOST + '/api/session', {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username: 'admin', password: PASS }).toString(),
});
const data = JSON.parse(await res.text());
const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

for (const [label, path] of [['/cd-server', '/cd-server'], ['/kvm', '/kvm']]) {
  await new Promise((resolve) => {
    const sock = tls.connect({ host: HOST, port: 443, rejectUnauthorized: false }, () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\nHost: ${HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${Buffer.from('0123456789abcdef').toString('base64')}\r\nSec-WebSocket-Version: 13\r\n` +
        `Sec-WebSocket-Protocol: binary\r\nSec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n` +
        `Origin: https://${HOST}\r\nCookie: ${cookie}\r\n\r\n`,
      );
    });
    let got = Buffer.alloc(0);
    sock.on('data', (d) => {
      got = Buffer.concat([got, d]);
      if (got.length >= 16) {
        const head = got.subarray(0, 40).toString('latin1').replace(/\r\n/g, ' | ');
        const isHttp = got.subarray(0, 4).toString('latin1') === 'HTTP';
        console.log(`[${label}] ${isHttp ? 'HTTP 响应' : '二进制帧'}: ${head}`);
        console.log(`   hex: ${[...got.subarray(0, 20)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
        sock.destroy(); resolve();
      }
    });
    sock.on('error', (e) => { console.log(`[${label}] 连接失败: ${e.message}`); resolve(); });
    sock.on('close', () => resolve());
    setTimeout(() => { sock.destroy(); resolve(); }, 6000);
  });
}
try { await fetch('https://' + HOST + '/api/session', { method: 'DELETE', headers: { cookie, 'x-csrftoken': data.CSRFToken } }); } catch {}
process.exit(0);
