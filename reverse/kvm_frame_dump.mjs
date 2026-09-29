// ⚠️ 用完务必注销：该 BMC 的 web 会话上限很小（148），泄漏会占满后
// 导致登录被拒（Maximum number of sessions already in use）且 KVM 升级被降级。
// KVM 视频包字节级取证：按「流」重组（包可能跨 WS 消息、也可能一消息多包），
// 打印首个视频包的帧头 hex，用于确定分辨率 / CompressSize 的真实偏移。
import { Agent, fetch as uFetch } from 'undici';
import { WebSocket } from 'ws';
// ⚠️ 需要 BMC 凭据：先设置环境变量 BMC_PASS 再运行

const BMC = 'https://192.168.0.200';
const HOST = '192.168.0.200';
const USER = 'admin';
const PASS = process.env.BMC_PASS || '';
const SECONDS = Number(process.argv[2] || 12);

const agent = new Agent({ connect: { rejectUnauthorized: false } });
const fetch = (url, opts = {}) => uFetch(url, { ...opts, dispatcher: agent });

const CMD = {
  RESUME_REDIRECTION: 0x06, VALIDATE: 0x12, GET_WEB_TOKEN: 0x15,
  CONNECTION_ALLOWED: 0x17, VIDEO_PACKETS: 0x19, KVM_SHARING: 0x20,
  DISPLAY_LOCK_SET: 0x33, MEDIA_LICENSE_STATUS: 0x35, KEEP_ALIVE: 0x39,
  CONNECTION_COMPLETE: 0x3a,
};
const NAME = Object.fromEntries(Object.entries(CMD).map(([k, v]) => [v, k]));
const SSI_LEN = 129, IP_LEN = 65, USER_LEN = 129, MAC_LEN = 49;

const packet = (cmd, status, payload = Buffer.alloc(0)) => {
  const b = Buffer.alloc(8 + payload.length);
  b.writeUInt16LE(cmd, 0); b.writeUInt32LE(payload.length, 2); b.writeUInt16LE(status, 6);
  payload.copy(b, 8); return b;
};
const cstr = (s, n) => { const b = Buffer.alloc(n); b.write(String(s), 0, 'utf8'); return b; };

const res = await fetch(BMC + '/api/session', {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username: USER, password: PASS }).toString(),
});
const data = JSON.parse(await res.text());
const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
const cfg = await (await fetch(BMC + '/api/settings/media/h5viewercfg', {
  headers: { cookie, 'x-csrftoken': data.CSRFToken },
})).json();
console.log('token', JSON.stringify(cfg.token), 'session', JSON.stringify(cfg.session).slice(0, 40) + '...');

const ws = new WebSocket(`wss://${HOST}/kvm`, ['binary', 'base64'], {
  rejectUnauthorized: false, origin: `https://${HOST}`, headers: { Cookie: cookie },
});

// ---------- 流式重组 ----------
let acc = Buffer.alloc(0);
let prevComplete = true;       // 上一帧是否已完整（决定本包是否带 86B 帧头）
let curFrame = Buffer.alloc(0);
let curSize = -1, curHdr = null;
let frames = 0, packets = 0, dumpDone = false;
const seq = [];
let keepAlive = null;

function drain() {
  while (acc.length >= 8) {
    const cmd = acc.readUInt16LE(0), len = acc.readUInt32LE(2), status = acc.readUInt16LE(6);
    if (acc.length < 8 + len) break;
    const payload = acc.subarray(8, 8 + len);
    acc = acc.subarray(8 + len);
    handle(cmd, len, status, payload);
  }
}

function handle(cmd, len, status, payload) {
  if (cmd === CMD.VIDEO_PACKETS) {
    packets++;
    // 实测偏移：载荷前 2 字节跳过；帧头 86B 位于 payload[2..88)；
    // CompressSize = payload[71..75) 小端；压缩数据从 payload[88) 起
    if (prevComplete) {
      const h = payload.subarray(2, 74);
      curHdr = h;
      curSize = payload[71] | (payload[72] << 8) | (payload[73] << 16) | (payload[74] << 24);
      curFrame = Buffer.from(payload.subarray(88));
      console.log(`[帧头] ${h.readUInt16LE(4)}x${h.readUInt16LE(6)}` +
        ` Dst ${h.readUInt16LE(13)}x${h.readUInt16LE(15)}` +
        ` tblSel=${h[44]} yuvMap=${h[45]} advSel=${h[47]} rc4=${h[53]}` +
        ` mode420=${h[55]} CompressSize=${curSize} 本包数据=${len - 88}`);
    } else {
      curFrame = Buffer.concat([curFrame, payload.subarray(2)]);
    }
    if (curSize > 0 && curFrame.length === curSize) {
      frames++;
      console.log(`  ★ 第 ${frames} 帧完成 ${curFrame.length} 字节` +
        ` 头=${curFrame[0].toString(16)} ${curFrame[1].toString(16)} ${curFrame[2].toString(16)} ${curFrame[3].toString(16)}` +
        ` 尾=${curFrame[curSize - 2].toString(16)} ${curFrame[curSize - 1].toString(16)}`);
      curFrame = Buffer.alloc(0); curSize = -1; prevComplete = true;
    } else {
      prevComplete = false;
    }
    return;
  }
  if (cmd === 0x13) {
    console.log(`← VALIDATED status=${status} payload=[${[...payload].join(',')}]  → ${
      payload[0] === 1 ? 'VALID' : 'INVALID(值' + payload[0] + ')'}`);
  }
  if (seq.length < 40) seq.push(`← ${NAME[cmd] ?? 'cmd' + cmd}(${cmd}) len=${len} status=${status}` +
    (cmd === 0x20 || cmd === 0x12 || cmd === 0x22 ? ` payload=[${[...payload].slice(0, 6).join(',')}]` : ''));

  if (cmd === CMD.CONNECTION_ALLOWED) {
    const body = Buffer.concat([
      Buffer.from([0]), cstr(cfg.token, SSI_LEN), cstr(cfg.client_ip, IP_LEN),
      cstr('domain/username', USER_LEN), cstr('00-00-00-00-00-00', MAC_LEN), cstr(cfg.server_ip, IP_LEN),
    ]);
    ws.send(Buffer.concat([packet(CMD.CONNECTION_COMPLETE, 1), packet(CMD.VALIDATE, 1, body),
      packet(CMD.RESUME_REDIRECTION, 0)]));
  } else if (cmd === CMD.KVM_SHARING) {
    console.log(`← KVM_SHARING low=${status & 0xff} high=${status >> 8} payloadLen=${len}`);
    ws.send(packet(CMD.KVM_SHARING, 1 | (2 << 8), payload));
  } else if (cmd === CMD.MEDIA_LICENSE_STATUS) {
    ws.send(packet(CMD.DISPLAY_LOCK_SET, 0, Buffer.from([2])));
    ws.send(packet(0x28, 0));
    ws.send(packet(CMD.GET_WEB_TOKEN, 0, Buffer.from(String(cfg.session))));
  }
}

let rxBytes = 0;
ws.on('open', () => { console.log('✓ WS open, protocol=', ws.protocol); keepAlive = setInterval(() => ws.send(packet(CMD.KEEP_ALIVE, 0)), 5000); });
ws.on('message', (d) => { rxBytes += d.length; acc = Buffer.concat([acc, Buffer.isBuffer(d) ? d : Buffer.from(d)]); drain(); });
ws.on('error', (e) => console.error('✗ WS 错误', e.message));
ws.on('close', (c, r) => console.log('WS close code=', c, 'reason=', String(r)));
ws.on('unexpected-response', (_q, r) => console.log('✗ WS 非预期响应', r.statusCode, r.statusMessage));

setTimeout(async () => {
  clearInterval(keepAlive);
  console.log('\n===== 控制包序列 =====');
  for (const s of seq) console.log(s);
  console.log(`\n视频包 ${packets} 个 / 完整帧 ${frames} 个 / 残余缓冲 ${acc.length} 字节`);
  try { ws.send(packet(0x08, 0)); console.log('→ STOP_SESSION_IMMEDIATE'); } catch {}
  try { await fetch(BMC + '/api/session', { method: 'DELETE', headers: { cookie, 'x-csrftoken': data.CSRFToken }, dispatcher: agent }); } catch {}
  setTimeout(() => { try { ws.close(); } catch {} process.exit(0); }, 400);
}, SECONDS * 1000);
