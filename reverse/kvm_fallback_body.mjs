// 取 /kvm 升级后那段"回退 HTTP 响应"的正文，看 BMC 到底回了什么。
import tls from 'node:tls';
import zlib from 'node:zlib';
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

const sock = tls.connect({ host: HOST, port: 443, rejectUnauthorized: false }, () => {
  sock.write(
    `GET /kvm HTTP/1.1\r\nHost: ${HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${Buffer.from('0123456789abcdef').toString('base64')}\r\nSec-WebSocket-Version: 13\r\n` +
    `Sec-WebSocket-Protocol: binary\r\nOrigin: https://${HOST}\r\nCookie: ${cookie}\r\n\r\n`,
  );
});

let buf = Buffer.alloc(0);
sock.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  const first = buf.indexOf('\r\n\r\n');
  if (first < 0) return;
  const rest = buf.subarray(first + 4);
  const second = rest.indexOf('\r\n\r\n');
  if (second < 0) return;
  const head = rest.subarray(0, second).toString();
  const body = rest.subarray(second + 4);
  const gz = /content-encoding:\s*gzip/i.test(head);
  console.log('=== 升级后的第二个 HTTP 响应头 ===');
  console.log(head);
  console.log(`=== 正文（${body.length} 字节，gzip=${gz}）===`);
  let text = null;
  if (gz) { try { text = zlib.gunzipSync(body).toString(); } catch (e) { text = '(gunzip 失败: ' + e.message + ')'; } }
  else text = body.toString('utf8');
  console.log(text.slice(0, 1200));
  try { sock.end(); } catch {}
  setTimeout(() => process.exit(0), 300);
});
sock.on('error', (e) => { console.log('错误', e.message); process.exit(1); });
setTimeout(() => { console.log('超时'); process.exit(0); }, 9000);
