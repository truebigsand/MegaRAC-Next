// KVM 客户端：与代理的 /api/kvm 通信。
//
// 服务端已把视频流重组为**完整帧**下发，所以这里不做协议解析：
//   文本帧   = JSON（{type:'state'|'frame'|'blank'|'power', ...}）
//   二进制帧 = 紧跟 frame 消息之后的一帧压缩数据
// 这样做是因为视频帧是差分的（AST2100 有 skip 码，块未变化时沿用上一帧像素），
// 浏览器从半途接入时若自己解析裸字节流，帧边界永远对不齐 → 一帧都收不齐（实测踩过）。
//
// 解码用 BMC 自带的 AST2100 worker（经 /api/kvm/decoder.js 代理下发）。
// ⚠️ worker 的输出缓冲必须**跨帧持续存在**：每帧新建空白 ImageData 会把
// 未变化区域抹成黑块（实测踩过）。

export type KvmState =
  | 'idle'
  | 'connecting'
  | 'handshaking'
  | 'waiting-permission'
  | 'streaming'
  | 'closed'
  | 'failed';

/** 与服务端 FrameMeta 对应，字段名即解码 worker 期望的形状 */
interface FrameMeta {
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

export interface VideoFrame {
  image: ImageData;
  width: number;
  height: number;
  frames: number;
  fps: number;
}

export interface KvmHandlers {
  onState(state: KvmState, detail: string): void;
  onFrame(frame: VideoFrame): void;
  /** 主机画面尺寸变化 */
  onResolution(width: number, height: number): void;
  /** 在线 KVM 客户端列表（谁在看这台机器） */
  onClients?(list: KvmClientInfo[]): void;
  onLog?(text: string): void;
}

export interface KvmClientInfo {
  name: string;
  ip: string;
  id: number;
  privilege: number;
}

interface ServerMessage {
  type: string;
  state?: KvmState;
  detail?: string;
  header?: FrameMeta;
  size?: number;
  on?: boolean;
  list?: KvmClientInfo[];
}

/** 把字节按 4 个一组塞进 Int32 数组（小端）——解码 worker 的数据形状 */
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
  /** 上一个 frame 消息的元信息，等紧随其后的二进制帧 */
  private pendingMeta: FrameMeta | null = null;
  private frameCount = 0;
  private frameTimes: number[] = [];
  private resolutionSet = false;

  constructor(handlers: KvmHandlers) {
    this.handlers = handlers;
  }

  private setState(state: KvmState, detail = '') {
    this.state = state;
    this.handlers.onState(state, detail);
  }

  async start(): Promise<void> {
    this.setState('connecting');
    await this.startWorker();

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/api/kvm`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        this.onJson(ev.data);
        return;
      }
      this.onBinary(new Uint8Array(ev.data as ArrayBuffer));
    };
    ws.onerror = () => this.setState('failed', 'WebSocket 错误');
    ws.onclose = () => {
      if (this.state !== 'failed') this.setState('closed');
    };
  }

  private onJson(text: string) {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(text) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'state':
        if (msg.state) this.setState(msg.state, msg.detail ?? '');
        break;
      case 'frame':
        this.pendingMeta = msg.header ?? null;
        break;
      case 'reset':
        // 服务端要重发整屏：丢掉手上的解码缓冲，等那一屏完整帧来重建
        this.resolutionSet = false;
        this.pendingMeta = null;
        break;
      case 'blank':
        this.handlers.onLog?.('主机画面空屏（未上电或无信号）');
        this.setState('streaming', '主机无信号');
        break;
      case 'power':
        this.handlers.onLog?.(`电源状态：${msg.on ? '开机' : '关机'}`);
        break;
      case 'clients':
        this.handlers.onClients?.(msg.list ?? []);
        break;
      default:
        break;
    }
  }

  private onBinary(bytes: Uint8Array) {
    const meta = this.pendingMeta;
    if (!meta || !this.worker) return;
    this.pendingMeta = null;

    const { X, Y } = meta.SourceModeInfo;
    if (X !== this.width || Y !== this.height) {
      this.width = X;
      this.height = Y;
      this.handlers.onResolution(X, Y);
      this.postResolution(X, Y);
    } else if (!this.resolutionSet) {
      this.postResolution(X, Y);
    }

    // 只截取 CompressSize 指定长度（多出的是填充字节）
    const need = meta.CompressData.CompressSize;
    const data = bytes.length > need ? bytes.subarray(0, need) : bytes;
    this.worker.postMessage({ header: meta, buffer: toInt32Array(data) });
  }

  private async startWorker(): Promise<void> {
    if (this.worker) return;
    const res = await fetch('/api/kvm/decoder.js');
    if (!res.ok) throw new Error(`解码 worker 获取失败（HTTP ${res.status}）`);
    // worker 脚本来自 BMC，必须同源加载 → 用 Blob URL（经典 worker，非 module）
    const url = URL.createObjectURL(await res.blob());
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = (e: MessageEvent) => {
      const data = e.data as { cmd: string; ibuf?: ImageData; ex?: string };
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
        this.handlers.onLog?.('解码异常: ' + (data.ex ?? ''));
      }
    };
    worker.onerror = (e) => this.handlers.onLog?.('worker 错误: ' + e.message);
    this.worker = worker;
  }

  private postResolution(w: number, h: number) {
    if (!this.worker || w <= 0 || h <= 0) return;
    // 解码器需要一个与画面同尺寸的 ImageData 作为**跨帧持续存在**的输出缓冲
    this.worker.postMessage({ cmd: 'resolution_changed', imageBuffer: new ImageData(w, h) });
    this.resolutionSet = true;
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

  /** 键鼠与画面控制：页面把浏览器事件翻译成 HID 语义后送来，服务端编码成 USB 报文 */
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

  /** 请服务端让 BMC 重发一屏完整画面（画面残影或刚接入时用） */
  refresh() {
    this.send({ kind: 'refresh' });
  }

  stop() {
    // 明确告知服务端这是用户主动断开：不要保留 BMC 会话供复用，
    // 否则下次连接会复用一个（可能是只读从属的）旧会话
    if (this.ws?.readyState === WebSocket.OPEN) this.send({ kind: 'disconnect' });
    this.worker?.terminate();
    this.worker = null;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
    this.pendingMeta = null;
    this.frameTimes = [];
    this.resolutionSet = false;
    this.setState('idle');
  }
}
