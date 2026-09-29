// 单口模式下 KVM 由 lighttpd 代理到后端；这里直接试 KVM 自己的端口（adviser.kvm_port=80）。
import net from 'node:net';
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
const cfg = await (await fetch('https://' + HOST + '/api/settings/media/h5viewercfg', {
  headers: { cookie, 'x-csrftoken': data.CSRFToken } })).json();
console.log('adviser:', JSON.stringify(await (await fetch('https://' + HOST + '/api/settings/media/adviser', {
  headers: { cookie, 'x-csrftoken': data.CSRFToken } })).json()));

for (const port of [80, 5900, 443]) {
  await new Promise((resolve) => {
    const sock = net.connect({ host: HOST, port }, () => {
      sock.write(`GET /kvm HTTP/1.1\r\nHost: ${HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${Buffer.from('0123456789abcdef').toString('base64')}\r\nSec-WebSocket-Version: 13\r\n` +
        `Sec-WebSocket-Protocol: binary\r\nOrigin: https://${HOST}\r\nCookie: ${cookie}\r\n\r\n`);
    });
    let got = Buffer.alloc(0);
    sock.on('data', (d) => {
      got = Buffer.concat([got, d]);
      if (got.length > 80) {
        const head = got.subarray(0, 60).toString('latin1').replace(/\r\n/g, ' | ');
        console.log(`\n[端口 ${port}] 前 60 字节: ${head}`);
        console.log(`  hex: ${[...got.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
        // 判断是 WS 帧（二进制协议包）还是 HTTP
        const isAscii = got.subarray(0, 4).toString('latin1') === 'HTTP';
        console.log(`  类型: ${isAscii ? 'HTTP 响应' : '二进制（疑似 WS 帧）'}`);
        sock.destroy(); resolve();
      }
    });
    sock.on('error', (e) => { console.log(`\n[端口 ${port}] 连接失败: ${e.message}`); resolve(); });
    sock.on('close', () => resolve());
    setTimeout(() => { sock.destroy(); resolve(); }, 6000);
  });
}
try { await fetch('https://' + HOST + '/api/session', { method: 'DELETE', headers: { cookie, 'x-csrftoken': data.CSRFToken } }); } catch {}
process.exit(0);
