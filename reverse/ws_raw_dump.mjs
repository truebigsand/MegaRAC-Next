// 打印升级后的**原始字节**（不做 WS 帧解析），看 BMC 到底发了什么。
import tls from 'node:tls';
import { Agent, fetch as uFetch } from 'undici';

const HOST = '192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const fetch = (u, o = {}) => uFetch(u, { ...o, dispatcher: agent });
const res = await fetch('https://' + HOST + '/api/session', {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username: 'admin', password: 'REDACTED_BMC_PASSWORD' }).toString(),
});
const data = JSON.parse(await res.text());
const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
const cfg = await (await fetch('https://' + HOST + '/api/settings/media/h5viewercfg', {
  headers: { cookie, 'x-csrftoken': data.CSRFToken } })).json();

const sock = tls.connect({ host: HOST, port: 443, rejectUnauthorized: false }, () => {
  sock.write(
    `GET /kvm HTTP/1.1\r\nHost: ${HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${Buffer.from('0123456789abcdef').toString('base64')}\r\nSec-WebSocket-Version: 13\r\n` +
    `Sec-WebSocket-Protocol: binary\r\nSec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n` +
    `Origin: https://${HOST}\r\nCookie: ${cookie}\r\n\r\n`,
  );
});

let n = 0;
let got = Buffer.alloc(0);
sock.on('data', (c) => {
  got = Buffer.concat([got, c]);
  if (n < 3) {
    console.log(`\n--- 第 ${++n} 批数据（累计 ${got.length} 字节）---`);
    const show = got.subarray(0, 420);
    for (let i = 0; i < show.length; i += 32) {
      const row = show.subarray(i, i + 32);
      console.log(
        String(i).padStart(4) + ': ' +
        [...row].map((b) => b.toString(16).padStart(2, '0')).join(' ') + '  |' +
        [...row].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('') + '|',
      );
    }
  }
  if (got.length > 2000) { sock.end(); setTimeout(() => process.exit(0), 300); }
});
sock.on('error', (e) => { console.log('sock 错误', e.message); process.exit(1); });
setTimeout(() => { console.log(`\n超时，共 ${got.length} 字节`); process.exit(0); }, 10000);
