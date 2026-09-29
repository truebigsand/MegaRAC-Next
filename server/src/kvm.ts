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

/**
 * 浏览器侧的出口。
 *
 * 注意这里下发的是**已重组的完整帧**而不是原始协议字节：
 * 浏览器重连/刷新后是从半途接入的，而视频帧是差分的（skip 码沿用上一帧），
 * 若把裸字节流交给浏览器，它的帧边界永远对不齐 → 一帧都收不齐。
 * 服务端按 stream 消费后，浏览器只从「下一个完整帧」开始渲染，天然对齐。
 */
export interface KvmSink {
  /** 控制/元信息（JSON 文本帧） */
  send(obj: unknown): void;
  /** 一帧的压缩数据（二进制帧） */
  sendBinary(buf: Buffer): void;
}

/** 交给浏览器与解码 worker 的帧信息（字段名与 worker 期望的一致） */
export interface FrameMeta {
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
    sink.send({
      type: 'state',
      state: this.state,
      detail: this.detail || (this.state === 'streaming' ? '已复用现有 KVM 会话' : ''),
    });
    if (this.state === 'streaming') {
      // 新客户端从半途接入，解码缓冲是空的：要一整屏完整帧，否则差分的增量
      // 会在空缓冲上解出花屏（实测过）
      this.requestFullFrame();
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

  /** 帧重组的中间状态 */
  private videoPrevComplete = true;
  private videoParts: Buffer[] = [];
  private videoLen = 0;
  private videoMeta: FrameMeta | null = null;

  /** 把视频包流按「帧」重组（规则见 docs/API.md 第 7 节），收齐一帧就下发 */
  private onVideoPacket(payload: Buffer) {
    if (this.videoPrevComplete) {
      // 帧头 86 字节在 payload[2..88)
      const h = payload.subarray(2, 88);
      this.videoMeta = {
        SourceModeInfo: { X: h.readUInt16LE(4), Y: h.readUInt16LE(6) },
        DestinationModeInfo: { X: h.readUInt16LE(13), Y: h.readUInt16LE(15) },
        FrameHeader: {
          JPEGTableSelector: h[44],
          JPEGYUVTableMapping: h[45],
          AdvanceTableSelector: h[47],
          RC4Enable: h[53],
        },
        Mode420: h[55],
        // 与固件一致：只取 3 字节（原版读 e[72] 越界恒为 0）
        CompressData: { CompressSize: payload[71] | (payload[72] << 8) | (payload[73] << 16) },
      };
      this.videoParts = [payload.subarray(88)];
      this.videoLen = payload.length - 88;
    } else {
      this.videoParts.push(payload.subarray(2));
      this.videoLen += payload.length - 2;
    }

    const need = this.videoMeta?.CompressData.CompressSize ?? 0;
    if (need > 0 && this.videoLen >= need) {
      const data = Buffer.concat(this.videoParts, need);
      this.stats.frames++;
      this.sink?.send({ type: 'frame', header: this.videoMeta, size: need });
      this.sink?.sendBinary(data);
      this.videoParts = [];
      this.videoLen = 0;
      this.videoPrevComplete = true;
    } else {
      this.videoPrevComplete = false;
    }
  }

  /** 请求重绘（原版「刷新画面」同款）：让 BMC 把画面变化区重发一遍，不清客户端缓冲 */
  refresh() {
    this.ws?.send(packet(CMD.REFRESH_VIDEO_SCREEN, 0));
  }

  /**
   * 要一整屏完整帧：先 `CMD_PAUSE_REDIRECTION` 再 `CMD_RESUME_REDIRECTION`。
   * 原版注释写明 resume 会拿到 full screen video buffer，这也正是客户端
   * 「中途接入」时唯一能拿到完整帧的办法（REFRESH 只补变化区）。
   * 同时清掉半截帧状态并让浏览器重建解码缓冲。
   */
  private requestFullFrame() {
    if (this.ws?.readyState !== WsClient.OPEN) return;
    this.ws.send(packet(CMD.PAUSE_REDIRECTION, 0));
    this.videoParts = [];
    this.videoLen = 0;
    this.videoPrevComplete = true; // 恢复后从完整帧开始
    this.sink?.send({ type: 'reset' });
    setTimeout(() => {
      if (this.ws?.readyState === WsClient.OPEN) {
        this.ws.send(packet(CMD.RESUME_REDIRECTION, 0));
      }
    }, 150);
  }

  get attached(): boolean {
    return this.sink !== null;
  }

  /**
   * 会话是否还能复用：以 BSD socket 真实存活为准。
   * 只看 state 不够——握手期就崩掉的会话 state 可能还停在 handshaking。
   */
  get usable(): boolean {
    if (this.closed || this.state === 'failed' || this.state === 'closed') return false;
    return this.ws?.readyState === WsClient.OPEN;
  }

  private setState(state: KvmState, detail = '') {
    this.state = state;
    this.detail = detail;
    this.sink?.send({ type: 'state', state, detail });
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
      // 关掉底层连接：否则 readyState 仍是 OPEN，会被当成"还能用"而复用
      try {
        this.ws?.terminate();
      } catch {
        /* 忽略 */
      }
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
    // 优先级通道：BMC 慢时也要能连上，别被后台轮询挤掉
    const res = await this.bmc.get('/api/settings/media/h5viewercfg', true);
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
        if (low === SHARING.STATUS_KVM_PRIV_RESPONSE_TO_SLAVE && (status >> 8) === SHARING.KVM_REQ_ALLOWED) {
          // 明确的「已授予完全控制」
          this.grantFullAccess('主控权已授予');
        } else if (low === SHARING.STATUS_KVM_PRIV_SWITCH_MASTER) {
          // 服务器把主控权交接给我们
          this.grantFullAccess('主控权已交接');
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
        this.onVideoPacket(payload);
        return;
      }
      case CMD.PAINT_BLANK_SCREEN:
        this.sink?.send({ type: 'blank' });
        return;
      case CMD.POWER_STATUS:
        this.sink?.send({ type: 'power', on: status === 1 });
        return;
      case CMD.KEEP_ALIVE_PKT:
        return; // 心跳不必转发给浏览器
      case CMD.ACTIVE_CLIENTS: {
        // 每条 134 字节：用户名(64) + IP(65) + 会话 id(1) + IPMI 特权(4)
        const list: { name: string; ip: string; id: number; privilege: number }[] = [];
        for (let off = 0; off + 134 <= payload.length; off += 134) {
          const cut = (b: Buffer) => b.toString('utf8').replace(/ +$/, '').trim();
          list.push({
            name: cut(payload.subarray(off, off + 64)),
            ip: cut(payload.subarray(off + 64, off + 129)),
            id: payload[off + 129],
            privilege: payload[off + 130],
          });
        }
        this.sink?.send({ type: 'clients', list, master: this.gotMaster, sessionIndex: this.sessionIndex });
        return;
      }
      default:
        return;
    }
  }

  /**
   * 是否已取得**完全控制**（只有它才代表键鼠有效）。
   * ⚠️ 不能把 `RESPONSE_TO_SLAVE` 一律当授权：实测会收到
   * `resp-to-slave/master-terminated`（旧主控退出），那不是授权，
   * 误判会导致停在"只读从属"却不再申请（踩过）。
   */
  private gotMaster = false;
  private masterRetry: NodeJS.Timeout | null = null;
  private masterSince = 0;

  /**
 * 从属会话申请完全控制：CMD_SET_NEXT_MASTER(0x32) len=0 status=0。
 * 这是原版「请求完全控制」按钮发的那一包（viewer 的 requestFullAccess）。
 * 主控侧收到后会弹窗询问，回了授权我们才拿到键鼠；主控已消失时由 BMC 超时接管。
 * 因此这里按固定间隔重试，直到收到授权（KVM_SHARING 的 RESPONSE_TO_SLAVE/SWITCH_MASTER）。
 */
  private requestFullAccess() {
    if (this.gotMaster) return;
    if (!this.masterSince) {
      this.masterSince = Date.now();
      this.masterReconnects = 0;
    }
    this.ws?.send(packet(CMD.SET_NEXT_MASTER, 0));
    if (!this.masterRetry) {
      this.masterRetry = setInterval(() => {
        if (this.gotMaster || this.closed) {
          this.stopMasterRetry();
          return;
        }
        // 申请迟迟没被批：多半是旧主控在 BMC 侧还没释放。
        // 重连一次通常能直接拿到主控（见 docs/API.md 的重连竞态说明），最多试 3 次。
        if (Date.now() - this.masterSince > 12_000 && this.masterReconnects < 3) {
          this.masterReconnects++;
          this.masterSince = Date.now();
          this.emit('state', this.state, `未获授权，重连争取主控（第 ${this.masterReconnects} 次）`);
          this.restartRequested = true;
          this.ws?.close();
          return;
        }
        this.ws?.send(packet(CMD.SET_NEXT_MASTER, 0));
      }, 4000);
    }
  }

  /** 已拿到完全控制 */
  private grantFullAccess(detail: string) {
    this.gotMaster = true;
    this.masterSince = 0;
    this.stopMasterRetry();
    this.setState('streaming', detail);
  }

  private masterReconnects = 0;
  /** 该会话因争取主控而主动断开、需要重建（由 route 读取） */
  restartRequested = false;

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
    // sink 可能已经被清掉（会话自行断开争主控时）
    this.sink?.send({ type: 'state', state: 'closed', detail: '' });
    this.setState('closed');
    this.emit('closed');
    this.removeAllListeners();
  }
}
