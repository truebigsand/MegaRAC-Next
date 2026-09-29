// ⚠️ 用完务必注销：该 BMC 的 web 会话上限很小（148），泄漏会占满后
// 导致登录被拒（Maximum number of sessions already in use）且 KVM 升级被降级。
// 手工做 WebSocket 升级并抓原始帧头字节，判断 BMC 到底发了什么。
import tls from 'node:tls';
import { Agent, fetch as uFetch } from 'undici';
import zlib from 'node:zlib';

const HOST = '192.168.0.200';
const BMC = 'https://' + HOST;
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const fetch = (u, o = {}) => uFetch(u, { ...o, dispatcher: agent });

const res = await fetch(BMC + '/api/session', {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username: 'admin', password: 'REDACTED_BMC_PASSWORD' }).toString(),
});
const data = JSON.parse(await res.text());
const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
const cfg = await (await fetch(BMC + '/api/settings/media/h5viewercfg', {
  headers: { cookie, 'x-csrftoken': data.CSRFToken } })).json();
console.log('token', cfg.token ? 'ok' : 'missing');

const key = Buffer.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))).toString('base64');
const sock = tls.connect({ host: HOST, port: 443, rejectUnauthorized: false }, () => {
  sock.write(
    `GET /kvm HTTP/1.1\r\nHost: ${HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
    `Sec-WebSocket-Protocol: binary\r\nSec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n` +
    `Origin: ${BMC}\r\nCookie: ${cookie}\r\n\r\n`,
  );
});

let phase = 'http';
let buf = Buffer.alloc(0);
let frames = 0;
sock.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  if (phase === 'http') {
    const i = buf.indexOf('\r\n\r\n');
    if (i < 0) return;
    console.log('=== 升级响应 ===');
    console.log(buf.subarray(0, i).toString());
    buf = buf.subarray(i + 4);
    phase = 'ws';
  }
  while (buf.length >= 2) {
    const b0 = buf[0], b1 = buf[1];
    const fin = (b0 & 0x80) >> 7, rsv1 = (b0 & 0x40) >> 6, rsv2 = (b0 & 0x20) >> 5, rsv3 = (b0 & 0x10) >> 4;
    const opcode = b0 & 0x0f, masked = (b1 & 0x80) >> 7;
    let len = b1 & 0x7f, off = 2;
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    if (masked) off += 4;
    if (buf.length < off + len) break;
    const payload = buf.subarray(off, off + len);
    if (frames < 6) {
      console.log(`帧#${frames} FIN=${fin} RSV1=${rsv1} RSV2=${rsv2} RSV3=${rsv3} opcode=${opcode} masked=${masked} len=${len}`);
      const head = payload.subarray(0, Math.min(16, payload.length));
      console.log('   前 16 字节:', [...head].map((b) => b.toString(16).padStart(2, '0')).join(' '));
      // 试解：permessage-deflate 用 raw deflate，且消息尾部的 00 00 ff ff 被去掉
      try {
        const inflated = zlib.inflateRawSync(Buffer.concat([payload, Buffer.from([0, 0, 0xff, 0xff])]));
        console.log(`   → inflateRaw 成功，解出 ${inflated.length} 字节，前 16: ` +
          [...inflated.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join(' '));
      } catch (e) {
        console.log('   → inflateRaw 失败:', e.message);
      }
    }
    frames++;
    buf = buf.subarray(off + len);
    if (frames >= 6) { sock.end(); setTimeout(() => process.exit(0), 300); return; }
  }
});
sock.on('error', (e) => { console.log('sock 错误', e.message); process.exit(1); });
setTimeout(() => { console.log(`超时，共收到 ${frames} 帧`); process.exit(0); }, 12000);
