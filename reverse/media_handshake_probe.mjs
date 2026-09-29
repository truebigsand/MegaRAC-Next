// 验证虚拟介质（本地 ISO 重定向）握手：连 /cd-server，发 AUTH + DEVICE_INFO，看服务器回什么。
// 包结构取自 BMC 的 libs/media/*（IUSBHeader 32B + SCSI 数据区，opcode 在偏移 41）。
// ⚠️ 用完务必注销：该 BMC 的 web 会话表很小（148）。
import { Agent, fetch as uFetch } from 'undici';
import { WebSocket } from 'ws';

const HOST = '192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const fetch = (u, o = {}) => uFetch(u, { ...o, dispatcher: agent });

const HD = 32;            // IUSB 头长度
const OPCODE_OFF = 41;    // SCSI opcode 在包内的偏移
const PKT_OFF = 62;       // SCSI 数据区（auth/device-info 载荷）起始偏移
const AUTH_CMD = 0xf2;
const DEVICE_INFO = 0xf8;
const ACK = 0xf1;
const KEEP_ALIVE = 0xf3;

function iusbPacket(dataLen, opcode, payload) {
  const buf = Buffer.alloc(PKT_OFF + payload.length);
  buf.write('IUSB    ', 0, 'ascii');
  buf.writeUInt8(1, 8);            // major
  buf.writeUInt8(0, 9);            // minor
  buf.writeUInt8(HD, 10);          // headerLength
  buf.writeUInt8(0, 11);           // headerCheckSum
  buf.writeUInt32LE(buf.length, 12); // dataPacketLength（服务端按此读取）
  buf.writeUInt8(0, 16);           // serverCaps
  buf.writeUInt8(0x05, 17);        // deviceType
  buf.writeUInt8(0x01, 18);        // protocol
  buf.writeUInt8(0x80, 19);        // direction = FROM_CLIENT
  buf.writeUInt8(0, 20);           // deviceNo
  buf.writeUInt8(0, 21);           // interfaceNo
  buf.writeUInt8(0, 22);           // clientData
  buf.writeUInt8(0, 23);           // instance
  buf.writeUInt32LE(0, 24);        // sequenceNo
  buf.writeUInt8(opcode, OPCODE_OFF);
  payload.copy(buf, PKT_OFF);
  return buf;
}

const res = await fetch(`https://${HOST}/api/session`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username: 'admin', password: 'REDACTED_BMC_PASSWORD' }).toString(),
});
const data = JSON.parse(await res.text());
const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
const cfg = await (await fetch(`https://${HOST}/api/settings/media/h5viewercfg`, {
  headers: { cookie, 'x-csrftoken': data.CSRFToken } })).json();
console.log('token:', JSON.stringify(cfg.token), ' session:', JSON.stringify(cfg.session));

const ws = new WebSocket(`wss://${HOST}/cd-server`, ['binary', 'base64'], {
  rejectUnauthorized: false, origin: `https://${HOST}`,
});
let acc = Buffer.alloc(0);
let got = [];

ws.on('open', () => {
  console.log('✓ /cd-server 已连接');
  const check = async () => {
    const r = await fetch(`https://${HOST}/api/settings/media/active_redirections`, { headers: { cookie, 'x-csrftoken': data.CSRFToken } });
    console.log('   active_redirections:', r.status, (await r.text()).slice(0, 120));
  };
  void check();
  // AUTH：载荷 = flag(0) + token
  const authPayload = Buffer.concat([Buffer.from([0]), Buffer.from(String(cfg.token), 'utf8')]);
  ws.send(iusbPacket(PKT_OFF + authPayload.length, AUTH_CMD, authPayload));
  console.log('→ AUTH 已发送');
  // DEVICE_INFO：载荷 = u32(3) + 文件名 + \0
  const info = Buffer.concat([
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(3); return b; })(),
    Buffer.from('test.iso\0', 'utf8'),
  ]);
  ws.send(iusbPacket(PKT_OFF + info.length, DEVICE_INFO, info));
  console.log('→ DEVICE_INFO 已发送');
});

ws.on('message', (d) => {
  acc = Buffer.concat([acc, Buffer.isBuffer(d) ? d : Buffer.from(d)]);
  while (acc.length >= HD) {
    const dataLen = acc.readUInt32LE(12);
    if (acc.length < HD + dataLen) break;
    const pkt = acc.subarray(0, HD + dataLen);
    acc = acc.subarray(HD + dataLen);
    const opcode = pkt[OPCODE_OFF];
    const name = opcode === ACK ? 'DEVICE_REDIRECTION_ACK' : opcode === KEEP_ALIVE ? 'KEEP_ALIVE'
      : `opcode 0x${opcode.toString(16)}`;
    if (opcode === ACK) {
      const status = pkt[PKT_OFF + 30];
      const ip = pkt.subarray(PKT_OFF + 31, PKT_OFF + 31 + 39).toString('ascii').replace(/\0.*$/, '');
      console.log(`← ${name} dataLen=${dataLen} connectionStatus=${status} otherIP="${ip}"`);
      console.log(`   整包 hex(${pkt.length}): ${pkt.toString('hex')}`);
      console.log('   状态含义: 1=接受 3=登录失败 4=已被占用 5=无权限 8=超过最大用户 9=无法连接');
    } else if (got.length < 6) {
      console.log(`← ${name} dataLen=${dataLen} 前16字节: ${pkt.subarray(0, 16).toString('hex')}`);
    }
    got.push(opcode);
  }
});
ws.on('error', (e) => console.log('✗ WS 错误:', e.message));
ws.on('close', (c) => console.log('WS 关闭', c));

setTimeout(async () => {
  console.log(`\n共收到 ${got.length} 个包，opcode: ${got.slice(0, 10).map((o) => '0x' + o.toString(16)).join(', ')}`);
  try { ws.close(); } catch {}
  try { await fetch(`https://${HOST}/api/session`, { method: 'DELETE', headers: { cookie, 'x-csrftoken': data.CSRFToken } }); } catch {}
  setTimeout(() => process.exit(0), 300);
}, 9000);
