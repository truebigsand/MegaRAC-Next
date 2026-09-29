// HID 报文逐字节核对：把 BMC 原版（usbmessage.js / usbmousemessage.js）的构造逻辑
// 按原样转写一遍，与 server/src/hid.ts 的输出逐字节比对。
// 这是「键鼠报文结构正确」的可复核证据——键盘已在真机验证有回显，鼠标报文同理需核对。
import { keyboardReport, mouseReport } from '../server/src/hid.ts';

const HDR = 8;
const U = {
  IUSB_HID_HDR_SIZE: 34, KEYBDREP: 8, MOUSEREL: 4, MOUSEABS: 6, IUSB_HDR_SIZE: 32,
  PROTO_KEYBD: 0x10, PROTO_MOUSE: 0x20, DEVICE_KEYBD: 0x30, DEVICE_MOUSE: 0x31,
  MAJOR: 1, MINOR: 0, KEYBD_DEVNUM: 2, KEYDB_IFNUM: 0, MOUSE_DEVNUM: 2, MOUSE_IFNUM: 1,
  FROM_REMOTE: 0x80,
};
const CMD_SEND_HID = 0x01;

/** 原版公共头（writeString('IUSB    ') + 各字段），dataLen 由调用方给出 */
function origHeader(device, proto, ifNum, dataLen, seq) {
  const b = Buffer.alloc(U.IUSB_HDR_SIZE);
  let p = 0;
  b.write('IUSB    ', p); p += 8;
  b.writeInt8(U.MAJOR, p++);
  b.writeInt8(U.MINOR, p++);
  b.writeInt8(U.IUSB_HDR_SIZE, p++);
  b.writeInt8(0, p++); // 校验和占位
  b.writeInt32LE(dataLen, p); p += 4;
  b.writeInt8(0, p++);
  b.writeInt8(device, p++);
  b.writeInt8(proto, p++);
  b.writeUInt8(U.FROM_REMOTE & 0xff, p++);
  b.writeInt8(U.KEYBD_DEVNUM, p++);
  b.writeInt8(ifNum, p++);
  b.writeInt8(0, p++);
  b.writeInt8(0, p++);
  b.writeInt32LE(seq, p); p += 4;
  b.writeInt8(0, p++);
  b.writeInt8(0, p++);
  b.writeInt8(0, p++);
  b.writeInt8(0, p++);
  return b;
}

function origChecksum(usbHeader) {
  let temp = 0;
  for (const byte of usbHeader) temp = (temp + byte) & 0xff;
  return -temp & 0xff;
}

function origWrap(usbHeaderWithChecksum, lenByte, report) {
  const usb = Buffer.concat([usbHeaderWithChecksum, Buffer.from([lenByte]), report]);
  const out = Buffer.alloc(HDR + usb.length);
  out.writeUInt16LE(CMD_SEND_HID, 0);
  out.writeUInt32LE(usb.length, 2);
  out.writeUInt16LE(0, 6);
  usb.copy(out, 8);
  return out;
}

/** 原版 USBMouseMessage.ABSReport() */
function origMouseAbs(btn, x, y, wheel, screenW, screenH, seq) {
  const sx = Math.trunc((x * 32767) / screenW + 0.5); // setInt16 会截断
  const sy = Math.trunc((y * 32767) / screenH + 0.5);
  const dataPktLen = U.IUSB_HID_HDR_SIZE - 1 + U.MOUSEABS - U.IUSB_HDR_SIZE; // = 7
  const hdr = origHeader(U.DEVICE_MOUSE, U.PROTO_MOUSE, U.MOUSE_IFNUM, dataPktLen, seq);
  hdr.writeUInt8(origChecksum(hdr), 11);
  const report = Buffer.alloc(U.MOUSEABS);
  report.writeInt8(btn, 0);
  report.writeInt16LE(sx, 1);
  report.writeInt16LE(sy, 3);
  report.writeInt8(wheel, 5);
  return origWrap(hdr, U.MOUSEABS, report);
}

/** 原版 USBMouseMessage.RELReport()（注意长度字节原版写的是 ABS 的 6） */
function origMouseRel(btn, x, y, wheel, last, screenW, screenH, seq) {
  const dx = last == null ? 0 : x - last.x;
  const dy = last == null ? 0 : y - last.y;
  const dataPktLen = U.IUSB_HID_HDR_SIZE - 1 + U.MOUSEREL - U.IUSB_HDR_SIZE; // = 5
  const hdr = origHeader(U.DEVICE_MOUSE, U.PROTO_MOUSE, U.MOUSE_IFNUM, dataPktLen, seq);
  hdr.writeUInt8(origChecksum(hdr), 11);
  const report = Buffer.alloc(U.MOUSEREL);
  report.writeInt8(btn, 0);
  report.writeInt8(dx, 1);
  report.writeInt8(dy, 2);
  report.writeInt8(wheel, 3);
  return origWrap(hdr, U.MOUSEABS, report); // ← 与原版一致：长度字节写 6
}

/** 原版键盘报文（USBKeyboardPacket：modifiers + 按下标志 + 6 键码） */
function origKeyboard(mod, keys, seq) {
  const dataPktLen = U.IUSB_HID_HDR_SIZE - 1 + U.KEYBDREP - U.IUSB_HDR_SIZE; // = 9
  const hdr = origHeader(U.DEVICE_KEYBD, U.PROTO_KEYBD, U.KEYDB_IFNUM, dataPktLen, seq);
  hdr.writeUInt8(origChecksum(hdr), 11);
  const report = Buffer.alloc(U.KEYBDREP);
  report.writeInt8(mod, 0);
  report.writeInt8(keys.length ? 1 : 0, 1);
  for (let i = 0; i < Math.min(6, keys.length); i++) report.writeInt8(keys[i], 2 + i);
  return origWrap(hdr, U.KEYBDREP, report);
}

// ---------- 比对 ----------
let failures = 0;
function cmp(name, mine, want) {
  const ok = mine.length === want.length && mine.equals(want);
  console.log(`${ok ? '✓' : '✗'} ${name}  我的=${mine.length}B 原版=${want.length}B`);
  if (!ok) {
    failures++;
    const n = Math.max(mine.length, want.length);
    for (let i = 0; i < n; i++) {
      const a = mine[i], b = want[i];
      if (a !== b) console.log(`   偏移 ${i}: 我的=0x${(a ?? 0).toString(16).padStart(2, '0')} 原版=0x${(b ?? 0).toString(16).padStart(2, '0')}`);
    }
  }
  return ok;
}

// 序号从 0 起，两个实现都从 0 开始计数 → 需要各自独立的计数器，
// 这里通过「先跑原版再跑我的」并保证调用顺序一致来对齐序号
cmp('键盘 F2（mod=0 keys=[0x3b]）',
  keyboardReport(0, [0x3b]), origKeyboard(0, [0x3b], 0));
cmp('键盘 Ctrl+C（mod=0x01 keys=[0x06]）',
  keyboardReport(0x01, [0x06]), origKeyboard(0x01, [0x06], 1));
cmp('键盘 无按键（mod=0 keys=[]）',
  keyboardReport(0, []), origKeyboard(0, [], 2));
cmp('鼠标 绝对 (512,384) 1024x768 无按键',
  mouseReport(0, 512, 384, 0, 'absolute', 1024, 768),
  origMouseAbs(0, 512, 384, 0, 1024, 768, 0));
cmp('鼠标 绝对 左键 (100,200)',
  mouseReport(1, 100, 200, 0, 'absolute', 1024, 768),
  origMouseAbs(1, 100, 200, 0, 1024, 768, 1));
cmp('鼠标 绝对 滚轮 -1 (0,0)',
  mouseReport(0, 0, 0, -1, 'absolute', 1024, 768),
  origMouseAbs(0, 0, 0, -1, 1024, 768, 2));
cmp('鼠标 相对 首次 (10,20) 基准为空',
  mouseReport(0, 10, 20, 0, 'relative', 1024, 768, undefined),
  origMouseRel(0, 10, 20, 0, null, 1024, 768, 3));
cmp('鼠标 相对 增量 (+5,-3)',
  mouseReport(2, 15, 17, 1, 'relative', 1024, 768, { x: 10, y: 20 }),
  origMouseRel(2, 15, 17, 1, { x: 10, y: 20 }, 1024, 768, 4));

console.log(failures === 0 ? '\n全部一致 ✓' : `\n有 ${failures} 项不一致 ✗`);
process.exit(failures === 0 ? 0 : 1);
