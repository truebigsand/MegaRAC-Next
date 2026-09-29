// KVM 中继：服务端与 BMC 的 /kvm WebSocket 建连并完成 IVTP 握手，
// 之后作为**字节中继**工作——BMC 来的协议字节原样推给浏览器，
// 浏览器来的键鼠/控制包原样送回 BMC。
//
// 为什么握手放服务端而不是浏览器：
//   1) BMC 用自签证书，浏览器直连要先导入证书，体验不可接受；
//      Node 侧用 ws 的 rejectUnauthorized:false 只影响这一条连接。
//   2) 握手需要 token / 会话串 / 客户端 IP，这些都由服务端从已登录的
//      BmcClient 取，浏览器不必持有第二套凭证。
//
// 数据方向约定（浏览器侧）：
//   二进制帧 = IVTP 协议字节（需按 8 字节头 + len 流式重组）
//   文本帧   = JSON 状态/提示，例如 {"type":"state","state":"master"}
//
// 协议细节见 docs/API.md 第 7 节。
import { EventEmitter } from 'node:events';
import { WebSocket as WsClient } from 'ws';
import type { BmcClient } from './bmc.js';

const BMC_BASE = process.env.BMC_BASE || 'https://192.168.0.200';
const BMC_HOST = new URL(BMC_BASE).host;

/** IVTP 命令码（取自 BMC 的 libs/kvm/ivtp.js） */
export const CMD = {
  SEND_HID_PACKET: 0x01,
  SET_BANDWIDTH: 0x02,
  SET_FPS: 0x03,
  PAUSE_REDIRECTION: 0x04,
  REFRESH_VIDEO_SCREEN: 0x05,
  RESUME_REDIRECTION: 0x06,
  SET_COMPRESSION_TYPE: 0x07,
  STOP_SESSION_IMMEDIATE: 0x08,
  PAINT_BLANK_SCREEN: 0x09,
  USB_MOUSE_MODE: 0x0a,
  GET_FULL_SCREEN: 0x0b,
  VALIDATE_VIDEO_SESSION: 0x12,
  VALIDATED_VIDEO_SESSION: 0x13,
  GET_WEB_TOKEN: 0x15,
  CONNECTION_ALLOWED: 0x17,
  MEDIA_STATE: 0x18,
  VIDEO_PACKETS: 0x19,
  SET_MOUSE_MODE: 0x1c,
  KVM_SHARING: 0x20,
  SET_NEXT_MASTER: 0x32,
  POWER_STATUS: 0x22,
  POWER_CTRL_REQUEST: 0x23,
  ACTIVE_CLIENTS: 0x27,
  GET_USER_MACRO: 0x28,
  DISPLAY_LOCK_SET: 0x33,
  DISPLAY_CONTROL_STATUS: 0x34,
  MEDIA_LICENSE_STATUS: 0x35,
  SET_KBD_LANG: 0x37,
  KEEP_ALIVE_PKT: 0x39,
  CONNECTION_COMPLETE_PKT: 0x3a,
} as const;

/** KVM_SHARING 状态字段（低字节）与请求码（高字节） */
export const SHARING = {
  STATUS_KVM_PRIV_REQ_CANCEL: 0,
  STATUS_KVM_PRIV_REQ_MASTER: 1,
  STATUS_KVM_PRIV_WAIT_SLAVE: 2,
  STATUS_KVM_PRIV_REQ_TIMEOUT_TO_MASTER: 3,
  STATUS_KVM_PRIV_RESPONSE_TO_SLAVE: 4,
  STATUS_KVM_PRIV_SWITCH_MASTER: 6,
  KVM_REQ_ALLOWED: 0,
  KVM_REQ_DENIED: 1,
  KVM_REQ_PARTIAL: 2,
  KVM_REQ_TIMEOUT: 3,
  KVM_MASTER_TERMINATED: 9,
} as const;

export function sharingName(status: number): string {
  const low = status & 0xff;
  const high = status >> 8;
  const lowName =
    low === SHARING.STATUS_KVM_PRIV_REQ_CANCEL ? 'cancel'
    : low === SHARING.STATUS_KVM_PRIV_REQ_MASTER ? 'req-master'
    : low === SHARING.STATUS_KVM_PRIV_WAIT_SLAVE ? 'wait-slave'
    : low === SHARING.STATUS_KVM_PRIV_REQ_TIMEOUT_TO_MASTER ? 'req-timeout'
    : low === SHARING.STATUS_KVM_PRIV_RESPONSE_TO_SLAVE ? 'resp-to-slave'
    : low === SHARING.STATUS_KVM_PRIV_SWITCH_MASTER ? 'switch-master'
    : 'low' + low;
  const highName =
    high === SHARING.KVM_REQ_ALLOWED ? 'allowed'
    : high === SHARING.KVM_REQ_DENIED ? 'denied'
    : high === SHARING.KVM_REQ_PARTIAL ? 'partial'
    : high === SHARING.KVM_REQ_TIMEOUT ? 'timeout'
    : high === SHARING.KVM_MASTER_TERMINATED ? 'master-terminated'
    : high === 7 ? 'master-reconn'
    : high === 0 ? ''
    : 'high' + high;
  return highName ? `${lowName}/${highName}` : lowName;
}

const EMPTY = Buffer.alloc(0);
const SSI_LEN = 129; // token 字段（含结尾 0）
const IP_LEN = 65;
const USER_LEN = 129;
const MAC_LEN = 49;

/** 组一个 IVTP 包：cmd u16 | len u32 | status u16 | payload */
export function packet(cmd: number, status: number, payload: Buffer = EMPTY): Buffer {
  const buf = Buffer.alloc(8 + payload.length);
  buf.writeUInt16LE(cmd, 0);
  buf.writeUInt32LE(payload.length, 2);
  buf.writeUInt16LE(status, 6);
  payload.copy(buf, 8);
  return buf;
}

/** 定长 C 字符串（UTF-8 + 补零） */
function cstr(s: string, n: number): Buffer {
  const buf = Buffer.alloc(n);
  buf.write(String(s), 0, Math.min(Buffer.byteLength(String(s)), n - 1), 'utf8');
  return buf;
}

export type KvmState =
  | 'connecting'
  | 'handshaking'
  | 'waiting-permission'
  | 'streaming'
  | 'closed'
  | 'failed';

interface ViewerCfg {
  token: string;
  session: string;
  client_ip: string;
  server_ip: string;
}

/** 浏览器侧的出口：把协议字节与状态推给当前浏览器的 WebSocket */
export interface KvmSink {
  onData(buf: Buffer): void;
  onState(state: KvmState, detail: string): void;
}

/**
 * 单条 KVM 会话（对应一条到 BMC 的 /kvm 连接）。
 *
 * ⚠️ 生命周期**不与浏览器 WebSocket 绑定**：浏览器断开后会话会保留一段时间
 * （graceMs），期间新的浏览器连接直接**复用**它。原因是 BMC 侧释放主控要好几秒，
 * 若断开就关、重连就重新握手，新连接会拿到「会话序号>0」变成从属——
 * 表现为画面正常但键鼠全部无效（实测踩过）。
 */
export class KvmSession extends EventEmitter {
  state: KvmState = 'connecting';
  detail = '';
  private ws: WsClient | null = null;
  private keepAlive: NodeJS.Timeout | null = null;
  private closed = false;
  readonly startedAt = Date.now();
  /** VALIDATED 回包里的会话序号：0 = 我们是主控，>0 = 已有别的会话占着主控 */
  sessionIndex: number | undefined;
  stats = { videoPackets: 0, videoBytes: 0, frames: 0 };

  /** 当前浏览器出口；null = 没有浏览器在看，但 BMC 连接仍保持 */
  private sink: KvmSink | null = null;
  private reapTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly bmc: BmcClient,
    /** 浏览器全部断开后，保持 BMC 会话多久（毫秒） */
    private readonly graceMs = 60_000,
  ) {
    super();
  }

  /** 挂上浏览器出口；若会话已在推流，入口处会立刻补发当前状态 */
  attach(sink: KvmSink) {
    if (this.reapTimer) {
      clearTimeout(this.reapTimer);
      this.reapTimer = null;
    }
    this.sink = sink;
    sink.onState(this.state, this.detail || (this.state === 'streaming' ? '已复用现有 KVM 会话' : ''));
    if (this.state === 'streaming') {
      // 新客户端从半途接入，解码缓冲是空的：让服务器重发一屏完整画面
      this.refresh();
    }
  }

  /** 摘掉浏览器出口并开始计时；超时无人接入才真正断开 */
  detach() {
    this.sink = null;
    if (this.reapTimer) clearTimeout(this.reapTimer);
    this.reapTimer = setTimeout(() => {
      this.reapTimer = null;
      this.close();
    }, this.graceMs);
  }

  /** 请求服务器重发一屏完整画面（原版「刷新画面」同款） */
  refresh() {
    this.ws?.send(packet(CMD.REFRESH_VIDEO_SCREEN, 0));
  }

  get attached(): boolean {
    return this.sink !== null;
  }

  /** 会话是否还能用（失败/已关闭的不能复用） */
  get usable(): boolean {
    return !this.closed && this.state !== 'failed' && this.state !== 'closed';
  }

  private setState(state: KvmState, detail = '') {
    this.state = state;
    this.detail = detail;
    this.sink?.onState(state, detail);
    this.emit('state', state, detail);
  }

  async start(): Promise<void> {
    // 先取配置：CONNECTION_ALLOWED 一到就要用 token，必须早于建连
    this.cfg = await this.fetchViewerCfg();

    this.ws = new WsClient(`wss://${BMC_HOST}/kvm`, ['binary', 'base64'], {
      rejectUnauthorized: false,
      // BMC 校验来源：缺省 Node 不发 Origin，会被拒
      origin: BMC_BASE,
      // ⚠️ 必须允许 permessage-deflate（ws 客户端默认就是开的）：
      // 该 BMC 的 KVM 服务会主动压缩帧，显式关掉会立刻报
      // "Invalid WebSocket frame: RSV1 must be clear"（实测 3/3 失败）。
      // 但它自己偶发协商不一致（约 1/8 次）也会报同样的错，故调用方有重试（见 kvm-route.ts）。
      perMessageDeflate: true,
    });

    this.ws.on('open', () => {
      this.setState('handshaking');
      // 保活：BMC 侧有空闲超时，原版每 3 秒发一次
      this.keepAlive = setInterval(() => {
        try {
          this.ws?.send(packet(CMD.KEEP_ALIVE_PKT, 0));
        } catch {
          /* 连接已断，close 事件会收尾 */
        }
      }, 3000);
    });

    this.ws.on('message', (data) => this.onBmcMessage(data as Buffer));
    this.ws.on('close', (code) => {
      this.cleanup();
      this.setState('closed', `code=${code}`);
    });
    this.ws.on('error', (err) => {
      this.cleanup();
      this.setState('failed', (err as Error).message);
    });

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => { this.ws?.off('error', onError); resolve(); };
      const onError = (e: Error) => { this.ws?.off('open', onOpen); reject(e); };
      this.ws!.once('open', onOpen);
      this.ws!.once('error', onError);
    }).catch((e) => {
      this.cleanup();
      throw e;
    });
  }

  private cfg: ViewerCfg | null = null;

  private async fetchViewerCfg(): Promise<ViewerCfg> {
    const res = await this.bmc.get('/api/settings/media/h5viewercfg');
    if (res.status !== 200 || !res.body) {
      throw new Error(`h5viewercfg 失败（HTTP ${res.status}）`);
    }
    const cfg = res.body as Partial<ViewerCfg>;
    if (!cfg.token || !cfg.server_ip) throw new Error('h5viewercfg 缺少 token/server_ip');
    return {
      token: cfg.token,
      session: cfg.session ?? '',
      client_ip: cfg.client_ip ?? '',
      server_ip: cfg.server_ip,
    };
  }

  private rxBuf: Buffer = EMPTY;

  /**
   * BMC → 浏览器。
   * ⚠️ BMC 的 WS 是**字节流**而不是「一消息一包」：一个包可能跨多条消息，
   * 一条消息也可能含多个包（原版用 nwBuffer + pos 流式消费，同此）。
   * 所以这里跨消息保留剩余字节，凑满一个包才处理。
   */
  private onBmcMessage(data: Buffer) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    this.rxBuf = this.rxBuf.length ? Buffer.concat([this.rxBuf, chunk]) : chunk;
    let off = 0;
    while (this.rxBuf.length - off >= 8) {
      const len = this.rxBuf.readUInt32LE(off + 2);
      if (this.rxBuf.length - off < 8 + len) break; // 包未收全，等后续消息
      if (len > 16 * 1024 * 1024) {
        // 长度不可能这么大：流已错位，丢弃并关接（正常情况不应发生）
        this.rxBuf = EMPTY;
        this.setState('failed', `协议流错位（len=${len}）`);
        this.ws?.close();
        return;
      }
      const cmd = this.rxBuf.readUInt16LE(off);
      const status = this.rxBuf.readUInt16LE(off + 6);
      const payload = this.rxBuf.subarray(off + 8, off + 8 + len);
      this.handleBmcPacket(cmd, len, status, payload);
      off += 8 + len;
    }
    this.rxBuf = off === 0 ? this.rxBuf : Buffer.from(this.rxBuf.subarray(off));
  }

  private handleBmcPacket(cmd: number, len: number, status: number, payload: Buffer) {
    switch (cmd) {
      case CMD.CONNECTION_ALLOWED: {
        // 服务器放行 → 立刻回「连接完成 + 校验会话 + 恢复重定向」三连（必须一串发出）
        const cfg = this.cfg!;
        const body = Buffer.concat([
          Buffer.from([0]), // flag
          cstr(cfg.token, SSI_LEN),
          cstr(cfg.client_ip, IP_LEN),
          cstr('domain/username', USER_LEN), // 原版回退值：LOCAL_USERNAME 未定义时用它
          cstr('00-00-00-00-00-00', MAC_LEN),
          cstr(cfg.server_ip, IP_LEN),
        ]);
        this.ws!.send(Buffer.concat([
          // ⚠️ 这 8 字节缺了会被判 INVALID_SESSION（reconnect 特性打开时原版总会带）
          packet(CMD.CONNECTION_COMPLETE_PKT, 1),
          packet(CMD.VALIDATE_VIDEO_SESSION, 1, body),
          packet(CMD.RESUME_REDIRECTION, 0),
        ]));
        break;
      }
      case CMD.VALIDATED_VIDEO_SESSION: {
        const result = payload[0];
        const sessionIndex = payload.length > 1 ? payload[1] : undefined;
        if (result !== 1) {
          this.setState('failed', `KVM 会话校验未通过（结果码 ${result}）`);
          return;
        }
        this.sessionIndex = sessionIndex;
        if (sessionIndex !== undefined && sessionIndex > 0) {
          // 会话序号 >0 = 已有别的会话占着主控，我们是从属（只能看画面，按键无效）。
          // 原版这里点「请求完全控制」按钮，发的是 CMD_SET_NEXT_MASTER(0x32) len=0 status=0；
          // 主控侧会收到该包并回授权，主控若已消失则由 BMC 超时后把主控权交给我们。
          this.setState('waiting-permission', `从属会话（序号=${sessionIndex}），已申请完全控制`);
          this.requestFullAccess();
        } else {
          this.setState('handshaking', `验证通过（主控会话 序号=${sessionIndex ?? '-'}）`);
        }
        break;
      }
      case CMD.SET_NEXT_MASTER:
      case CMD.KVM_SHARING: {
        const low = status & 0xff;
        const name = sharingName(status);
        // 别的会话在向我们申请完全控制（原版弹窗让人点同意，这里自动同意）。
        // 触发条件：low=REQ_MASTER。原版回包用 CMD 32 + CMD 50 各一发，status 带 ALLOWED。
        if (low === SHARING.STATUS_KVM_PRIV_REQ_MASTER) {
          const grant = SHARING.STATUS_KVM_PRIV_REQ_MASTER | (SHARING.KVM_REQ_ALLOWED << 8);
          this.ws!.send(packet(CMD.KVM_SHARING, grant, payload));
          this.ws!.send(packet(CMD.SET_NEXT_MASTER, grant, payload));
          this.gotMaster = true;
          this.stopMasterRetry();
          // 只报信息不改状态：我们本来就是主控，画面照常
          this.emit('state', this.state, `已授权另一会话完全控制（${name}）`);
          return;
        }
        if (low === SHARING.STATUS_KVM_PRIV_WAIT_SLAVE) {
          // 服务器明确告诉我们：主控在别人手上，我们在排队（原版弹"等待授权"对话框）。
          // 发完全控制申请并保持重试，拿到授权前键鼠不生效。
          this.setState('waiting-permission', `${name}，已申请完全控制`);
          this.requestFullAccess();
          return;
        }
        if (low === SHARING.STATUS_KVM_PRIV_RESPONSE_TO_SLAVE || low === SHARING.STATUS_KVM_PRIV_SWITCH_MASTER) {
          this.gotMaster = true;
          this.stopMasterRetry();
          this.setState('streaming', name);
        } else {
          this.emit('state', this.state, `共享状态 ${name}`);
        }
        break;
      }
      case CMD.MEDIA_LICENSE_STATUS: {
        // 媒体授权就绪 → 解锁显示并注册 web 会话串（顺序同原版）
        this.ws!.send(packet(CMD.DISPLAY_LOCK_SET, 0, Buffer.from([2])));
        this.ws!.send(packet(CMD.GET_USER_MACRO, 0));
        this.ws!.send(packet(CMD.GET_WEB_TOKEN, 0, Buffer.from(this.cfg!.session)));
        break;
      }
      case CMD.VIDEO_PACKETS: {
        this.stats.videoPackets++;
        this.stats.videoBytes += len;
        if (this.state !== 'streaming') this.setState('streaming');
        break;
      }
      case CMD.KEEP_ALIVE_PKT:
        return; // 心跳不必转发给浏览器
      default:
        break;
    }
    // 其余一律原样转给浏览器（视频包、电源状态、在线客户端、空屏指令等）
    this.sink?.onData(packet(cmd, status, payload));
  }

  /** 是否已取得主控；未取得时定时重发请求 */
  private gotMaster = false;
  private masterRetry: NodeJS.Timeout | null = null;

  /**
 * 从属会话申请完全控制：CMD_SET_NEXT_MASTER(0x32) len=0 status=0。
 * 这是原版「请求完全控制」按钮发的那一包（viewer 的 requestFullAccess）。
 * 主控侧收到后会弹窗询问，回了授权我们才拿到键鼠；主控已消失时由 BMC 超时接管。
 * 因此这里按固定间隔重试，直到收到授权（KVM_SHARING 的 RESPONSE_TO_SLAVE/SWITCH_MASTER）。
 */
  private requestFullAccess() {
    if (this.gotMaster) return;
    this.ws?.send(packet(CMD.SET_NEXT_MASTER, 0));
    if (!this.masterRetry) {
      this.masterRetry = setInterval(() => {
        if (this.gotMaster || this.closed) {
          this.stopMasterRetry();
          return;
        }
        this.ws?.send(packet(CMD.SET_NEXT_MASTER, 0));
      }, 5000);
    }
  }

  private stopMasterRetry() {
    if (this.masterRetry) {
      clearInterval(this.masterRetry);
      this.masterRetry = null;
    }
  }

  /** 浏览器 → BMC：原样转发（键鼠 HID 包、画面控制等） */
  send(buf: Buffer) {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(buf);
  }

  private cleanup() {
    if (this.closed) return;
    this.closed = true;
    if (this.keepAlive) {
      clearInterval(this.keepAlive);
      this.keepAlive = null;
    }
    this.stopMasterRetry();
    if (this.reapTimer) {
      clearTimeout(this.reapTimer);
      this.reapTimer = null;
    }
  }

  close() {
    this.cleanup();
    if (this.ws) {
      this.ws.removeAllListeners('close');
      this.ws.removeAllListeners('error');
      try {
        if (this.ws.readyState === this.ws.OPEN) {
          // 主动通知服务器释放主控，避免占用 KVM 会话槽（否则下次连接会被当从属）
          this.ws.send(packet(CMD.STOP_SESSION_IMMEDIATE, 0));
        }
      } catch {
        /* 忽略 */
      }
      const ws = this.ws;
      setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* 忽略 */
        }
      }, 300);
      this.ws = null;
    }
    this.sink?.onState('closed', '');
    this.setState('closed');
    this.removeAllListeners();
  }
}
