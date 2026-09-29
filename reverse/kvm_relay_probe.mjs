// ⚠️ 用完务必注销：该 BMC 的 web 会话上限很小（148），泄漏会占满后
// 导致登录被拒（Maximum number of sessions already in use）且 KVM 升级被降级。
// 服务端 KVM 建连验证：用 ws 库（可关证书校验）在 Node 侧跑完整握手，确认能收到视频流。
// 这决定「服务端中继」方案是否可行——浏览器直连自签证书需要用户手动信任，不可接受。
//
// 用法: node reverse/kvm_relay_probe.mjs [持续秒数]
import { Agent, fetch as uFetch } from 'undici';
import { WebSocket } from 'ws';
// ⚠️ 需要 BMC 凭据：先设置环境变量 BMC_PASS 再运行

const BMC = 'https://192.168.0.200';
const HOST = '192.168.0.200';
const USER = 'admin';
const PASS = process.env.BMC_PASS || '';
const SECONDS = Number(process.argv[2] || 12);

// fetch 走 undici，ws 走自己的 TLS 选项，两者各自关证书校验
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const fetch = (url, opts = {}) => uFetch(url, { ...opts, dispatcher: agent });

const CMD = {
  SEND_HID: 0x01, RESUME_REDIRECTION: 0x06, GET_FULL_SCREEN: 0x0b,
  VALIDATE: 0x12, VALIDATED: 0x13, GET_WEB_TOKEN: 0x15,
  CONNECTION_ALLOWED: 0x17, VIDEO_PACKETS: 0x19, KVM_SHARING: 0x20,
  ACTIVE_CLIENTS: 0x27, GET_USER_MACRO: 0x28, DISPLAY_LOCK_SET: 0x33,
  MEDIA_LICENSE_STATUS: 0x35, KEEP_ALIVE: 0x39, CONNECTION_COMPLETE: 0x3a,
};
const NAME = Object.fromEntries(Object.entries(CMD).map(([k, v]) => [v, k]));

const SSI_LEN = 129, IP_LEN = 65, USER_LEN = 129, MAC_LEN = 49;

function packet(cmd, status, payload = Buffer.alloc(0)) {
  const b = Buffer.alloc(8 + payload.length);
  b.writeUInt16LE(cmd, 0);
  b.writeUInt32LE(payload.length, 2);
  b.writeUInt16LE(status, 6);
  payload.copy(b, 8);
  return b;
}
function cstr(s, n) {
  const b = Buffer.alloc(n);
  b.write(s, 0, 'utf8');
  return b;
}
function* parse(buf) {
  let off = 0;
  while (off + 8 <= buf.length) {
    const cmd = buf.readUInt16LE(off);
    const len = buf.readUInt32LE(off + 2);
    const status = buf.readUInt16LE(off + 6);
    yield { cmd, len, status, payload: buf.subarray(off + 8, off + 8 + len) };
    off += 8 + len;
    if (len <= 0) break; // 无 8 字节头的尾包（原版同样按此处理）
  }
}

async function login() {
  const res = await fetch(BMC + '/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: USER, password: PASS }).toString(),
  });
  const text = await res.text();
  const data = JSON.parse(text);
  if (data.ok !== 0) throw new Error('登录失败: ' + text);
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  return { csrf: data.CSRFToken, cookie };
}

const { csrf, cookie } = await login();
console.log('✓ 登录成功 racsession_id=', JSON.parse(await (await fetch(BMC + '/api/session', {
  headers: { cookie, 'x-csrftoken': csrf },
})).text()).racsession_id ?? '?');

const cfgRes = await fetch(BMC + '/api/settings/media/h5viewercfg', {
  headers: { cookie, 'x-csrftoken': csrf },
});
const cfg = await cfgRes.json();
console.log('h5viewercfg 字段:', Object.keys(cfg).join(', '));

const token = cfg.token;
const webSession = cfg.session;
const clientIp = cfg.client_ip;
const serverIp = cfg.server_ip;
console.log('token 长度', String(token).length, '| session 长度', String(webSession).length,
  '| client_ip', clientIp, '| server_ip', serverIp);
if (!token || !serverIp) { console.error('✗ 缺少 token/server_ip'); process.exit(1); }

// ⚠️ 必须带 Origin：BMC 校验来源，缺省 Node 不发 Origin
const ws = new WebSocket(`wss://${HOST}/kvm`, ['binary', 'base64'], {
  rejectUnauthorized: false,
  origin: `https://${HOST}`,
  headers: { Cookie: cookie },
});

let videoCount = 0, videoBytes = 0, firstVideoLen = 0;
const seen = [];
let keepAlive = null;

ws.on('open', () => {
  console.log('✓ WebSocket 已连接，子协议 =', ws.protocol);
  keepAlive = setInterval(() => { try { ws.send(packet(CMD.KEEP_ALIVE, 0)); } catch {} }, 5000);
});

ws.on('message', (data) => {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  for (const p of parse(buf)) {
    if (p.cmd === CMD.VIDEO_PACKETS) {
      videoCount++; videoBytes += p.len;
      if (!firstVideoLen && p.len > 1) {
        firstVideoLen = p.len;
        // 首包带 86 字节帧头：SourceMode(4..7) / DestMode(13..16) / CompressSize(69..72)
        const h = p.payload;
        if (h.length > 80) {
          console.log(`  首视频包 len=${p.len} 源分辨率=${h.readUInt16LE(4)}x${h.readUInt16LE(6)}` +
            ` 目标分辨率=${h.readUInt16LE(13)}x${h.readUInt16LE(15)}` +
            ` JPEGTableSelector=${h[44]} YUVMap=${h[45]} RC4=${h[53]} Mode420=${h[55]}` +
            ` CompressSize=${h[69] | (h[70] << 8) | (h[71] << 16)}`);
        }
      }
      continue;
    }
    if (seen.length < 30) {
      seen.push(`← ${NAME[p.cmd] ?? 'cmd' + p.cmd}(${p.cmd}) len=${p.len} status=${p.status}`);
    }
    if (p.cmd === CMD.CONNECTION_ALLOWED) {
      const body = Buffer.concat([
        Buffer.from([0]),
        cstr(String(token), SSI_LEN),
        cstr(String(clientIp), IP_LEN),
        cstr('domain/username', USER_LEN),
        cstr('00-00-00-00-00-00', MAC_LEN),
        cstr(String(serverIp), IP_LEN),
      ]);
      ws.send(Buffer.concat([
        packet(CMD.CONNECTION_COMPLETE, 1),
        packet(CMD.VALIDATE, 1, body),
        packet(CMD.RESUME_REDIRECTION, 0),
      ]));
      console.log('→ CONNECTION_COMPLETE + VALIDATE(' + body.length + ') + RESUME_REDIRECTION');
    } else if (p.cmd === CMD.KVM_SHARING) {
      const low = p.status & 0xff, high = p.status >> 8;
      console.log(`← KVM_SHARING low=${low} high=${high} payloadLen=${p.len}`);
      // 原版编码：low=1(REQ_MASTER) | high=2(PARTIAL) —— 实测可直接取得 master
      ws.send(packet(CMD.KVM_SHARING, 1 | (2 << 8), p.payload));
      console.log('→ KVM_SHARING 请求 master (status=513)');
    } else if (p.cmd === CMD.MEDIA_LICENSE_STATUS) {
      ws.send(packet(CMD.DISPLAY_LOCK_SET, 0, Buffer.from([2])));
      ws.send(packet(CMD.GET_USER_MACRO, 0));
      ws.send(packet(CMD.GET_WEB_TOKEN, 0, Buffer.from(String(webSession))));
      console.log('→ DISPLAY_LOCK_SET + GET_USER_MACRO + GET_WEB_TOKEN');
    } else if (p.cmd === CMD.VALIDATED) {
      console.log('← VALIDATED status=' + p.status + ' payload=' + p.payload[0]);
    }
  }
});

ws.on('error', (e) => console.error('✗ WS 错误:', e.message));
ws.on('close', (code) => { console.log('WS 关闭 code=' + code); });

setTimeout(async () => {
  clearInterval(keepAlive);
  console.log('\n===== 控制包序列 =====');
  for (const s of seen) console.log(s);
  console.log('\n===== 视频统计 =====');
  console.log(`视频包 ${videoCount} 个，共 ${(videoBytes / 1024).toFixed(1)} KB`);
  try { ws.close(); } catch {}
  // 注销，避免占满 BMC 的 web 会话表
  try { await fetch(BMC + '/api/session', { method: 'DELETE', headers: { cookie, 'x-csrftoken': csrf }, dispatcher: agent }); } catch {}
  process.exit(0);
}, SECONDS * 1000);
