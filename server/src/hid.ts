// KVM 的键鼠 HID 报文构造（USB over IP 封装）。
// 结构照抄 BMC 的 libs/kvm/usbmessage.js + usbmousemessage.js，
// 连原版的小瑕疵一起保留（REL 报文的长度字节原版写的是 ABS 的 6），
// 因为固件是照着这份实现解析的。
//
// 报文布局（32 字节 USB 头，紧跟在 8 字节 IVTP 头之后）：
//   0..7   "IUSB    "
//   8      major=1        9 minor=0        10 hdrSize=32
//   11     校验和（USB 头 32 字节求和取负，8 位）
//   12..15 dataLen (u32 LE)
//   16     0
//   17     设备类型 0x30=键盘 0x31=鼠标
//   18     协议     0x10=键盘 0x20=鼠标
//   19     方向 0x80（从远端发出）
//   20     设备号=2      21 接口号（键盘 0 / 鼠标 1）
//   22..23 0
//   24..27 序号 (u32 LE)
//   28..31 0
// 随后是报告数据：
//   键盘 8 字节：[修饰键][1][6 个 HID 键码]
//   鼠标绝对 6 字节：[按键][x u16 LE 0..32767][y u16 LE][滚轮]
//   鼠标相对 4 字节：[按键][dx][dy][滚轮]

export const HID = {
  IUSB_HDR_SIZE: 32,
  KEYBD_REP_SIZE: 8,
  MOUSE_REL_REP_SIZE: 4,
  MOUSE_ABS_REP_SIZE: 6,
  PROTO_KEYBD: 0x10,
  PROTO_MOUSE: 0x20,
  DEVICE_KEYBD: 0x30,
  DEVICE_MOUSE: 0x31,
  MAJOR: 0x01,
  MINOR: 0x00,
  KEYBD_DEVNUM: 0x02,
  KEYBD_IFNUM: 0x00,
  MOUSE_DEVNUM: 0x02,
  MOUSE_IFNUM: 0x01,
  FROM_REMOTE: 0x80,
} as const;

/** IVTP 的 CMD_SEND_HID_PACKET */
const CMD_SEND_HID_PACKET = 0x01;
/** 绝对坐标上限（原版 DIRABS_MAX_SCALED_X/Y） */
const ABS_MAX = 32767;

export type MouseMode = 'absolute' | 'relative';

class HidSeq {
  private seq = 0;
  next(): number {
    return this.seq++;
  }
}

const keybdSeq = new HidSeq();
const mouseSeq = new HidSeq();

/**
 * 键盘与鼠标共用同一套头封装。
 * `lenByte` 是写进报告前那个长度字节的值（原版在 REL 报文里错写成 ABS 的 6，照抄）；
 * `body` 是真正的报告内容，IVTP 的 len 与 USB 头的 dataLen 都按 body 长度算。
 */
function usbPacket(
  device: number,
  proto: number,
  ifNum: number,
  lenByte: number,
  body: Buffer,
  seq: number,
): Buffer {
  const dataLen = 1 + body.length; // 长度字节 + 报告内容
  const usb = Buffer.alloc(HID.IUSB_HDR_SIZE);
  usb.write('IUSB    ', 0, 'ascii');
  usb.writeUInt8(HID.MAJOR, 8);
  usb.writeUInt8(HID.MINOR, 9);
  usb.writeUInt8(HID.IUSB_HDR_SIZE, 10);
  usb.writeUInt8(0, 11); // 校验和占位
  usb.writeUInt32LE(dataLen, 12);
  usb.writeUInt8(0, 16);
  usb.writeUInt8(device, 17);
  usb.writeUInt8(proto, 18);
  usb.writeUInt8(HID.FROM_REMOTE, 19);
  usb.writeUInt8(HID.KEYBD_DEVNUM, 20);
  usb.writeUInt8(ifNum, 21);
  usb.writeUInt8(0, 22);
  usb.writeUInt8(0, 23);
  usb.writeUInt32LE(seq, 24);
  usb.writeUInt8(0, 28);
  usb.writeUInt8(0, 29);
  usb.writeUInt8(0, 30);
  usb.writeUInt8(0, 31);

  let sum = 0;
  for (const b of usb) sum = (sum + b) & 0xff;
  usb.writeUInt8(-sum & 0xff, 11);

  const packetBody = Buffer.concat([usb, Buffer.from([lenByte & 0xff]), body]);
  const out = Buffer.alloc(8 + packetBody.length);
  out.writeUInt16LE(CMD_SEND_HID_PACKET, 0);
  out.writeUInt32LE(packetBody.length, 2);
  out.writeUInt16LE(0, 6);
  packetBody.copy(out, 8);
  return out;
}

/**
 * 键盘报告。`keys` 是 HID usage 码数组（最多 6 个），modifiers 是位掩码
 * （bit0=左Ctrl … bit4=左Shift … bit7=右GUI）。
 */
export function keyboardReport(modifiers: number, keys: number[]): Buffer {
  const report = Buffer.alloc(HID.KEYBD_REP_SIZE);
  report.writeUInt8(modifiers & 0xff, 0);
  // 第二个字节原版写的是「按键按下标志」，实测不影响识别
  report.writeUInt8(keys.length > 0 ? 1 : 0, 1);
  for (let i = 0; i < Math.min(6, keys.length); i++) report.writeUInt8(keys[i] & 0xff, 2 + i);
  return usbPacket(HID.DEVICE_KEYBD, HID.PROTO_KEYBD, HID.KEYBD_IFNUM, HID.KEYBD_REP_SIZE, report, keybdSeq.next());
}

/** 鼠标报告：按钮位掩码 + 坐标 + 滚轮 */
export function mouseReport(
  buttons: number,
  x: number,
  y: number,
  wheel: number,
  mode: MouseMode,
  screenW = 1,
  screenH = 1,
  last?: { x: number; y: number },
): Buffer {
  if (mode === 'absolute') {
    const sx = Math.round((x / screenW) * ABS_MAX);
    const sy = Math.round((y / screenH) * ABS_MAX);
    const report = Buffer.alloc(HID.MOUSE_ABS_REP_SIZE);
    report.writeUInt8(buttons & 0xff, 0);
    report.writeInt16LE(sx, 1);
    report.writeInt16LE(sy, 3);
    report.writeInt8(wheel, 5);
    return usbPacket(HID.DEVICE_MOUSE, HID.PROTO_MOUSE, HID.MOUSE_IFNUM, HID.MOUSE_ABS_REP_SIZE, report, mouseSeq.next());
  }
  const dx = last ? x - last.x : 0;
  const dy = last ? y - last.y : 0;
  const report = Buffer.alloc(HID.MOUSE_REL_REP_SIZE);
  report.writeUInt8(buttons & 0xff, 0);
  report.writeInt8(clamp8(dx), 1);
  report.writeInt8(clamp8(dy), 2);
  report.writeInt8(wheel, 3);
  // ⚠️ 长度字节原版写的是 ABS 的 6，即使本报文只有 4 字节 —— 与固件保持一致
  return usbPacket(HID.DEVICE_MOUSE, HID.PROTO_MOUSE, HID.MOUSE_IFNUM, HID.MOUSE_ABS_REP_SIZE, report, mouseSeq.next());
}

function clamp8(v: number): number {
  return Math.max(-128, Math.min(127, Math.round(v)));
}

/**
 * 浏览器来的 HID 指令（JSON）→ IVTP 二进制包。
 * 返回 null 表示这条指令不是 HID，交给调用方自行处理。
 */
export interface HidInput {
  kind: 'keyboard' | 'mouse';
  modifiers?: number;
  keys?: number[];
  buttons?: number;
  x?: number;
  y?: number;
  wheel?: number;
  /** 鼠标模式由设置端点决定，服务端缓存最近一次的值 */
  mode?: MouseMode;
  screenW?: number;
  screenH?: number;
}

export function hidPacket(input: HidInput, mode: MouseMode, last?: { x: number; y: number }): Buffer {
  if (input.kind === 'keyboard') {
    return keyboardReport(input.modifiers ?? 0, input.keys ?? []);
  }
  return mouseReport(
    input.buttons ?? 0,
    input.x ?? 0,
    input.y ?? 0,
    input.wheel ?? 0,
    mode,
    input.screenW ?? 1,
    input.screenH ?? 1,
    last,
  );
}
