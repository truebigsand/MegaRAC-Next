// KVM 握手实测：按原版 viewer 的字节结构，用 Node 原生 WebSocket 连 wss://<bmc>/kvm
//
// 流程（来自 viewer.min.js 逆向）：
//   1) 登录 → GET /api/kvm/token 取 {token, client_ip, session}
//   2) 连 wss://<bmc>/kvm，子协议 ["binary","base64"]
//   3) 等服务器发 CMD_CONNECTION_ALLOWED(23)
//   4) 发 CMD_VALIDATE_VIDEO_SESSION：8 字节头 + 438 字节载荷
//        载荷 = u8(0) + CString(token,129) + CString(client_ip,65)
//              + CString(username,129) + CString(mac,49) + CString(server_ip,65)
//        同一个 WS 消息里再追加 CMD_RESUME_REDIRECTION(6) 空包
//   5) 读后续包：CMD_VALIDATED_VIDEO_SESSION(19) / CMD_VIDEO_PACKETS(25) …
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const PROXY = 'http://127.0.0.1:5177';
const BMC_WS = 'wss://192.168.0.200/kvm';
const OBSERVE_MS = Number(process.env.OBSERVE_MS || 12000);

const CMD = {
  1: 'SEND_HID', 2: 'SET_BANDWIDTH', 7: 'SET_COMPRESSION', 19: 'VALIDATED_VIDEO_SESSION', 21: 'GET_WEB_TOKEN',
  23: 'CONNECTION_ALLOWED', 24: 'MEDIA_STATE', 25: 'VIDEO_PACKETS', 32: 'KVM_SHARING', 33: 'KVM_SOCKET_STATUS',
  34: 'POWER_STATUS', 37: 'SERVICE_INFO', 38: 'KVM_MEDIA_INFO', 39: 'ACTIVE_CLIENTS', 49: 'IPMI_RES',
  52: 'DISPLAY_CONTROL_STATUS', 53: 'MEDIA_LICENSE_STATUS', 54: 'KVM_DISCONNECT', 57: 'KEEP_ALIVE',
  58: 'CONNECTION_COMPLETE', 59: 'CONNECTION_FAILED', 60: 'FPS_DIFF', 61: 'KBD_QUEUE_STATUS',
};

// ---- 字节工具（对齐原版 DataStream：小端）----
function cstring(str, size) {
  const buf = Buffer.alloc(size, 0);
  Buffer.from(str, 'utf8').copy(buf, 0, 0, Math.min(Buffer.byteLength(str), size - 1));
  return buf;
}
function header(cmd, payloadLen, status) {
  const h = Buffer.alloc(8);
  h.writeUInt16LE(cmd, 0);
  h.writeUInt32LE(payloadLen, 4);
  h.writeUInt16LE(status, 6);
  return h;
}

// ---- 1. 取 token ----
let cookie = '';
async function proxyReq(method, path, body) {
  const h = cookie ? { cookie } : {};
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(PROXY + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  return res;
}
// 若外部提供了已登录的浏览器会话 cookie（BMC 会话表满时无法再登录），直接复用
if (process.env.REUSE_COOKIE) {
  cookie = process.env.REUSE_COOKIE;
  console.log('复用已有浏览器会话');
} else {
// BMC 在会话表吃紧时会瞬时失败（返回非 JSON），登录重试几次
let login = null;
for (let i = 1; i <= 4; i++) {
  login = await proxyReq('POST', '/api/auth/login', { username: 'admin', password: 'REDACTED_BMC_PASSWORD' });
  console.log(`登录（第 ${i} 次）:`, login.status);
  if (login.status === 200) break;
  await new Promise((r) => setTimeout(r, 3000));
}
if (login?.status !== 200) { console.log('登录始终失败，退出'); process.exit(1); }
}
let tokRes = await proxyReq('GET', '/bmc/kvm/token');
let tok = await tokRes.json();
if (!tok?.token) {
  console.log('token 接口异常，重试一次:', tokRes.status);
  await new Promise((r) => setTimeout(r, 2000));
  tokRes = await proxyReq('GET', '/bmc/kvm/token');
  tok = await tokRes.json();
}
if (!tok?.token) { console.log('未取得 token，退出:', JSON.stringify(tok)); process.exit(1); }
console.log('token 接口:', tokRes.status, JSON.stringify({ ...tok, token: tok.token ? tok.token.slice(0, 6) + '…' : null }));

// ---- 2. 建连 ----
const USERNAME = 'domain/username'; // 与原版一致（window.LOCAL_USERNAME 未定义时的回退值）
const MAC = '00-00-00-00-00-00';
const ws = new WebSocket(BMC_WS, ['binary', 'base64']);
ws.binaryType = 'arraybuffer';
let sentValidate = false;
const seen = new Map();
let videoPackets = 0;
let firstVideoHeader = null;
let totalBytes = 0;

const done = new Promise((resolve) => {
  const finish = (reason) => {
    try { ws.close(); } catch {}
    resolve(reason);
  };
  setTimeout(() => finish('观察结束'), OBSERVE_MS);

  ws.onopen = () => console.log(`WS 已连接（协商子协议: ${ws.protocol || '无'}）`);
  ws.onerror = (e) => { console.log('WS 错误:', e?.message || e?.type || 'unknown'); finish('连接错误'); };
  ws.onclose = (e) => { console.log(`WS 关闭 code=${e.code}`); resolve(`关闭(${e.code})`); };

  ws.onmessage = (ev) => {
    const buf = Buffer.from(ev.data);
    totalBytes += buf.length;
    if (buf.length < 8) return;
    const cmd = buf.readUInt16LE(0);
    const len = buf.readUInt32LE(4);
    const status = buf.readUInt16LE(6);
    const name = CMD[cmd] ?? `CMD_${cmd}`;
    seen.set(name, (seen.get(name) || 0) + 1);

    if (cmd === 25 /* VIDEO_PACKETS */ && videoPackets < 1) {
      // 首个视频包：按原版 parseFrameHeader 的偏移解析关键字段
      const p = buf.subarray(8);
      firstVideoHeader = {
        pkt_size: len,
        SourceMode: { X: p[4] | (p[5] << 8), Y: p[6] | (p[7] << 8) },
        DestinationMode: { X: p[13] | (p[14] << 8), Y: p[15] | (p[16] << 8) },
        JPEGTableSelector: p[44],
        JPEGYUVTableMapping: p[45],
        AdvanceTableSelector: p[47],
        RC4Enable: p[53],
        Mode420: p[55],
        CompressSize: p[69] | (p[70] << 8) | (p[71] << 16) | (p[72] << 24),
      };
    }
    if (cmd === 25) videoPackets++;
    if (cmd !== 25 || seen.get(name) <= 2) {
      console.log(`← ${name} cmd=${cmd} len=${len} status=${status}`);
    }

    // 3. 收到 CONNECTION_ALLOWED 后发握手包
    if (cmd === 23 && !sentValidate) {
      const payload = Buffer.concat([
        Buffer.from([0]),
        cstring(tok.token, 129),
        cstring(tok.client_ip, 65),
        cstring(USERNAME, 129),
        cstring(MAC, 49),
        cstring('192.168.0.200', 65),
      ]);
      const msg = Buffer.concat([
        header(19 /* CMD_VALIDATE_VIDEO_SESSION */, payload.length, 1),
        payload,
        header(6 /* CMD_RESUME_REDIRECTION */, 0, 0),
      ]);
      ws.send(msg);
      sentValidate = true;
      console.log(`→ VALIDATE_VIDEO_SESSION 已发送（载荷 ${payload.length} 字节，消息共 ${msg.length} 字节）`);
    }
  };
});

const reason = await done;
console.log(`\n===== 结果（${reason}）=====`);
console.log('收到报文统计:', [...seen.entries()].map(([k, v]) => `${k}×${v}`).join(', ') || '(无)');
console.log('视频包数量:', videoPackets, '| 总字节:', totalBytes);
if (firstVideoHeader) {
  const h = firstVideoHeader;
  console.log(`首个视频包头: 源 ${h.SourceMode.X}x${h.SourceMode.Y} → 目标 ${h.DestinationMode.X}x${h.DestinationMode.Y}`);
  console.log(`  JPEGTableSelector=${h.JPEGTableSelector} YUVTable=${h.JPEGYUVTableMapping} AdvanceTable=${h.AdvanceTableSelector} RC4=${h.RC4Enable} Mode420=${h.Mode420} CompressSize=${h.CompressSize}`);
}
await proxyReq('POST', '/api/auth/logout');
