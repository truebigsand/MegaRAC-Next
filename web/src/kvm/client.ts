// KVM 客户端：与代理的 /api/kvm 通信，重组 IVTP 字节流为完整帧，
// 交给 BMC 的 AST2100 解码 worker 还原成 ImageData。
//
// 关键事实（均实测，见 docs/API.md 第 7 节）：
//   · BMC 的 WS 是**字节流**：包可跨消息、消息可含多包 → 必须流式重组
//   · 视频包载荷：前 2 字节跳过；帧头 86 字节位于 payload[2..88)；
//     CompressSize 在 payload[71..74)（小端 3 字节，与固件一致）；压缩数据自 payload[88) 起
//   · 非首包（同一帧的后续包）数据自 payload[2] 起，长度 len-2
//   · 一帧的结束条件是累计字节数 == CompressSize

/** IVTP 命令码（取自 BMC 的 libs/kvm/ivtp.js） */
export const CMD = {
  SEND_HID_PACKET: 0x01,
  SET_BANDWIDTH: 0x02,
  PAUSE_REDIRECTION: 0x04,
  REFRESH_VIDEO_SCREEN: 0x05,
  RESUME_REDIRECTION: 0x06,
  STOP_SESSION_IMMEDIATE: 0x08,
  USB_MOUSE_MODE: 0x0a,
  GET_FULL_SCREEN: 0x0b,
  SET_MOUSE_MODE: 0x1c,
  KVM_SHARING: 0x20,
  POWER_STATUS: 0x22,
  POWER_CTRL_REQUEST: 0x23,
  ACTIVE_CLIENTS: 0x27,
  VIDEO_PACKETS: 0x19,
  PAINT_BLANK_SCREEN: 0x09,
} as const;

export type KvmState =
  | 'idle'
  | 'connecting'
  | 'handshaking'
  | 'waiting-permission'
  | 'streaming'
  | 'closed'
  | 'failed';

export interface VideoFrame {
  image: ImageData;
  /** 源分辨率（BMC 侧画面的真实尺寸） */
  width: number;
  height: number;
  /** 收发统计 */
  frames: number;
  fps: number;
}

export interface KvmHandlers {
  onState(state: KvmState, detail: string): void;
  onFrame(frame: VideoFrame): void;
  /** 主画面尺寸变化——调用方据此调整画布 */
  onResolution(width: number, height: number): void;
  onLog?(text: string): void;
}

interface FrameHeader {
  SourceModeInfo: { X: number; Y: number };
  DestinationModeInfo: { X: number; Y: number };
  FrameHeader: {
    JPEGTableSelector: number;
    JPEGYUVTableMapping: number;
    AdvanceTableSelector: number;
    RC4Enable: number;
  };
  Mode420: number;
  CompressData: { CompressSize: number };
}

/** 原版 makeIntArray：把字节按 4 个一组塞进 Int32 数组（小端） */
function toInt32Array(bytes: Uint8Array): Int32Array {
  const padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4);
  padded.set(bytes);
  return new Int32Array(padded.buffer);
}

export class KvmClient {
  state: KvmState = 'idle';
  width = 0;
  height = 0;

  private ws: WebSocket | null = null;
  private worker: Worker | null = null;
  private handlers: KvmHandlers;

  /** 协议流缓冲（跨 WS 消息保留） */
  private rx = new Uint8Array(0);
  /** 上一帧是否已完整收齐——决定下一包是否带帧头 */
  private prevComplete = true;
  private currentFrame: Uint8Array[] = [];
  private currentFrameLen = 0;
  private header: FrameHeader | null = null;

  private frameCount = 0;
  private frameTimes: number[] = [];

  constructor(handlers: KvmHandlers) {
    this.handlers = handlers;
  }

  private log(text: string) {
    this.handlers.onLog?.(text);
  }

  private setState(state: KvmState, detail = '') {
    this.state = state;
    this.handlers.onState(state, detail);
  }

  /** 建立连接并启动解码 worker */
  async start(): Promise<void> {
    this.setState('connecting');
    await this.startWorker();

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/api/kvm`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data) as { type: string; state?: KvmState; detail?: string };
          if (msg.type === 'state' && msg.state) this.setState(msg.state, msg.detail ?? '');
        } catch {
          /* 非 JSON 文本忽略 */
        }
        return;
      }
      this.push(new Uint8Array(ev.data as ArrayBuffer));
    };
    ws.onerror = () => this.setState('failed', 'WebSocket 错误');
    ws.onclose = () => {
      if (this.state !== 'failed') this.setState('closed');
    };
  }

  private async startWorker(): Promise<void> {
    if (this.worker) return;
    const res = await fetch('/api/kvm/decoder.js');
    if (!res.ok) throw new Error(`解码 worker 获取失败（HTTP ${res.status}）`);
    const code = await res.blob();
    // worker 脚本来自 BMC，必须同源加载 → 用 Blob URL（经典 worker，非 module）
    const url = URL.createObjectURL(code);
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = (e: MessageEvent) => {
      const data = e.data as { cmd: string; ibuf?: ImageData; ex?: string; args?: string };
      if (data.cmd === 'draw' && data.ibuf) {
        this.markFrame();
        this.handlers.onFrame({
          image: data.ibuf,
          width: this.width,
          height: this.height,
          frames: this.frameCount,
          fps: this.fps(),
        });
      } else if (data.cmd === 'exception') {
        this.log('解码异常: ' + (data.ex ?? ''));
      } else if (data.cmd === 'debug') {
        this.log(String(data.args ?? ''));
      }
    };
    worker.onerror = (e) => this.log('worker 错误: ' + e.message);
    this.worker = worker;
  }

  private markFrame() {
    this.frameCount++;
    const now = performance.now();
    this.frameTimes.push(now);
    while (this.frameTimes.length > 1 && now - this.frameTimes[0] > 2000) this.frameTimes.shift();
  }

  private fps(): number {
    if (this.frameTimes.length < 2) return 0;
    const span = (this.frameTimes[this.frameTimes.length - 1] - this.frameTimes[0]) / 1000;
    return span > 0 ? (this.frameTimes.length - 1) / span : 0;
  }

  /** 协议字节流重组：凑满一个包就处理 */
  private push(chunk: Uint8Array) {
    const merged = new Uint8Array(this.rx.length + chunk.length);
    merged.set(this.rx);
    merged.set(chunk, this.rx.length);
    this.rx = merged;

    let off = 0;
    const view = new DataView(this.rx.buffer);
    while (this.rx.length - off >= 8) {
      const len = view.getUint32(off + 2, true);
      if (this.rx.length - off < 8 + len) break;
      if (len > 16 * 1024 * 1024) {
        this.log(`协议流错位（len=${len}），已重置`);
        this.rx = new Uint8Array(0);
        this.ws?.close();
        return;
      }
      this.handlePacket(
        view.getUint16(off, true),
        view.getUint16(off + 6, true),
        this.rx.subarray(off + 8, off + 8 + len),
      );
      off += 8 + len;
    }
    if (off > 0) this.rx = this.rx.subarray(off);
  }

  private handlePacket(cmd: number, status: number, payload: Uint8Array) {
    switch (cmd) {
      case CMD.VIDEO_PACKETS:
        this.onVideoPacket(payload);
        return;
      case CMD.PAINT_BLANK_SCREEN:
        this.log('主机画面空屏（未上电或无信号）');
        return;
      case CMD.POWER_STATUS:
        this.log(`电源状态=${status}`);
        return;
      case CMD.KVM_SHARING:
        this.log(`主控状态 low=${status & 0xff} high=${status >> 8}`);
        return;
      default:
        // 其余控制包（在线客户端、键盘灯、宏等）暂不处理
        return;
    }
  }

  private onVideoPacket(payload: Uint8Array) {
    if (this.prevComplete) {
      // 帧头：payload[2..88)
      const h = payload.subarray(2, 88);
      const hv = new DataView(h.buffer, h.byteOffset, h.byteLength);
      this.header = {
        SourceModeInfo: { X: hv.getUint16(4, true), Y: hv.getUint16(6, true) },
        DestinationModeInfo: { X: hv.getUint16(13, true), Y: hv.getUint16(15, true) },
        FrameHeader: {
          JPEGTableSelector: h[44],
          JPEGYUVTableMapping: h[45],
          AdvanceTableSelector: h[47],
          RC4Enable: h[53],
        },
        Mode420: h[55],
        // ⚠️ 与固件一致：只取 3 字节（原版 e[72] 越界恒为 0）
        CompressData: { CompressSize: payload[71] | (payload[72] << 8) | (payload[73] << 16) },
      };
      const { X, Y } = this.header.SourceModeInfo;
      if (X !== this.width || Y !== this.height) {
        this.width = X;
        this.height = Y;
        this.handlers.onResolution(X, Y);
        this.postResolution(X, Y);
      }
      this.currentFrame = [payload.subarray(88)];
      this.currentFrameLen = payload.length - 88;
    } else {
      this.currentFrame.push(payload.subarray(2));
      this.currentFrameLen += payload.length - 2;
    }

    const need = this.header?.CompressData.CompressSize ?? 0;
    if (need > 0 && this.currentFrameLen >= need) {
      this.postFrame();
      this.prevComplete = true;
      this.currentFrame = [];
      this.currentFrameLen = 0;
    } else {
      this.prevComplete = false;
    }
  }

  private postResolution(w: number, h: number) {
    if (!this.worker) return;
    // 解码器需要一个与画面同尺寸的 ImageData 作为**跨帧持续存在**的输出缓冲（原版同样做法）
    this.worker.postMessage({ cmd: 'resolution_changed', imageBuffer: new ImageData(w, h) });
  }

  private postFrame() {
    if (!this.worker || !this.header) return;
    const need = this.header.CompressData.CompressSize;
    const bytes = new Uint8Array(need);
    let p = 0;
    for (const part of this.currentFrame) {
      if (p + part.length > need) {
        bytes.set(part.subarray(0, need - p), p);
        p = need;
        break;
      }
      bytes.set(part, p);
      p += part.length;
    }
    // ⚠️ 不要把输出缓冲每帧重建：AST2100 有 skip 码（块未变化时沿用上一帧像素），
    // 解码器必须持有**跨帧持续存在**的缓冲，否则未变化区域会被抹成黑块。
    // 缓冲只在分辨率变化时发一次（见 postResolution），worker 会回传该帧的副本。
    this.worker.postMessage({ header: this.header, buffer: toInt32Array(bytes) });
  }

  // ---------- 输入 ----------

  /** 键鼠事件：由页面把浏览器事件翻译成 HID 语义后送来 */
  send(input: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(input));
  }

  sendKeyboard(modifiers: number, keys: number[]) {
    this.send({ kind: 'keyboard', modifiers, keys });
  }

  sendMouse(
    buttons: number,
    x: number,
    y: number,
    wheel: number,
    screenW: number,
    screenH: number,
  ) {
    this.send({ kind: 'mouse', buttons, x, y, wheel, screenW, screenH });
  }

  /** 请求全屏刷新（画面出现残影时用） */
  refresh() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const buf = new Uint8Array(8);
      const dv = new DataView(buf.buffer);
      dv.setUint16(0, CMD.REFRESH_VIDEO_SCREEN, true);
      dv.setUint32(2, 0, true);
      dv.setUint16(6, 0, true);
      this.ws.send(buf);
    }
  }

  stop() {
    this.worker?.terminate();
    this.worker = null;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
    this.rx = new Uint8Array(0);
    this.currentFrame = [];
    this.currentFrameLen = 0;
    this.prevComplete = true;
    this.frameTimes = [];
    this.setState('idle');
  }
}
