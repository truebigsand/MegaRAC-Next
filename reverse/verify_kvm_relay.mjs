// ⚠️ 用完务必注销：该 BMC 的 web 会话上限很小（148），泄漏会占满后
// 导致登录被拒（Maximum number of sessions already in use）且 KVM 升级被降级。
// 中继端到端验证：登录代理 → 连 /api/kvm → 收二进制协议字节 → 自己重组帧 + 解出画面尺寸。
// 不依赖浏览器，用于在写 UI 之前确认服务端中继真的能送出视频流。
import { WebSocket } from 'ws';
import { writeFileSync } from 'node:fs';
// ⚠️ 需要 BMC 凭据：先设置环境变量 BMC_PASS 再运行

const PROXY = 'http://127.0.0.1:5177';
const USER = 'admin';
const PASS = process.env.BMC_PASS || '';
const SECONDS = Number(process.argv[2] || 15);

const login = await fetch(PROXY + '/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
});
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
console.log('代理登录:', login.status, await login.text());

// 解码 worker 也要能从代理取到
const dec = await fetch(PROXY + '/api/kvm/decoder.js', { headers: { cookie } });
const decBody = await dec.text();
console.log('解码 worker:', dec.status, dec.headers.get('content-type'), decBody.length, '字节');

const IVTP = {
  VIDEO_PACKETS: 0x19, PAINT_BLANK_SCREEN: 0x09, POWER_STATUS: 0x22,
  KVM_SHARING: 0x20, ACTIVE_CLIENTS: 0x27, VALIDATED: 0x13,
};
const NAME = Object.fromEntries(Object.entries(IVTP).map(([k, v]) => [v, k]));

const ws = new WebSocket(`ws://127.0.0.1:5177/api/kvm`, { headers: { cookie } });

let acc = Buffer.alloc(0);
let prevComplete = true, curFrame = Buffer.alloc(0), curSize = -1, curHdrW = 0, curHdrH = 0;
let frames = 0, packets = 0, bytes = 0, lastFrame = null;
const states = [];

function drain() {
  while (acc.length >= 8) {
    const cmd = acc.readUInt16LE(0), len = acc.readUInt32LE(2), status = acc.readUInt16LE(6);
    if (acc.length < 8 + len) break;
    const payload = acc.subarray(8, 8 + len);
    acc = acc.subarray(8 + len);
    if (cmd === IVTP.VIDEO_PACKETS) {
      packets++; bytes += len;
      if (prevComplete) {
        curHdrW = payload.readUInt16LE(6);
        curHdrH = payload.readUInt16LE(8);
        curSize = payload[71] | (payload[72] << 8) | (payload[73] << 16);
        curFrame = Buffer.from(payload.subarray(88));
      } else {
        curFrame = Buffer.concat([curFrame, payload.subarray(2)]);
      }
      if (curSize > 0 && curFrame.length === curSize) {
        frames++;
        lastFrame = Buffer.from(curFrame);
        prevComplete = true;
        if (frames <= 3) console.log(`★ 帧 ${frames}: ${curHdrW}x${curHdrH} ${curSize} 字节`);
      } else prevComplete = false;
      continue;
    }
    if (states.length < 30) states.push(`cmd${cmd}(${NAME[cmd] ?? '?'}) len=${len} status=${status}`);
  }
}

ws.on('message', (data, isBinary) => {
  if (!isBinary) { console.log('状态:', data.toString()); return; }
  acc = Buffer.concat([acc, data]);
  drain();
});
ws.on('open', () => console.log('✓ 已连接代理 /api/kvm'));
ws.on('close', (c, r) => console.log('代理 WS 关闭', c, String(r)));
ws.on('error', (e) => console.error('✗ 代理 WS 错误', e.message));

setTimeout(() => {
  console.log('\n===== 协议包序列 =====');
  for (const s of states) console.log(' ', s);
  console.log(`\n视频包 ${packets} / 完整帧 ${frames} / 共 ${(bytes / 1024).toFixed(1)} KB`);
  if (lastFrame) {
    const out = new URL('./kvm_assets/frame_capture.bin', import.meta.url);
    writeFileSync(out, lastFrame);
    console.log('末帧已存至', out, '（AST2100 压缩数据，供解码对照）');
  }
  ws.close();
  setTimeout(() => process.exit(0), 300);
}, SECONDS * 1000);
