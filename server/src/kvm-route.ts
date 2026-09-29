// KVM 的 HTTP/WS 路由：
//   GET  /api/kvm/decoder.js  —— 从 BMC 取回 AST2100 解码 worker（浏览器以 Blob Worker 加载）
//   WS   /api/kvm             —— 二进制帧 = IVTP 协议字节，文本帧 = JSON 状态与指令
//
// 一个浏览器会话同时只保留一条 KVM 连接：新连接会顶掉旧连接，
// 避免在 BMC 侧留下占着主控权的僵尸会话（实测这会令后续连接被判 INVALID_SESSION）。
import type { FastifyInstance } from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import { getSession } from './sessions.js';
import { fetchBmcAsset } from './bmc.js';
import { KvmSession } from './kvm.js';
import { hidPacket, type MouseMode } from './hid.js';

const COOKIE_NAME = 'mn_token';
/** KVM 解码 worker 在 BMC 上的路径（文件名固定） */
const DECODER_PATH = '/libs/kvm/ast/decode_worker.js';

/** 每个浏览器会话最多一条 KVM 连接 */
const live = new Map<string, KvmSession>();

let decoderCache: Buffer | null = null;

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export async function registerKvm(app: FastifyInstance) {
  // ---------- 解码 worker（浏览器侧 new Worker(blobURL) 需要同源脚本） ----------
  app.get('/api/kvm/decoder.js', async (_req, reply) => {
    if (!decoderCache) {
      const res = await fetchBmcAsset(DECODER_PATH);
      if (res.status !== 200 || res.body.length === 0) {
        return reply.code(502).send({ error: 'decoder_unavailable', status: res.status });
      }
      decoderCache = res.body;
      app.log.info(`已缓存 KVM 解码 worker（${(res.body.length / 1024).toFixed(1)} KB）`);
    }
    return reply.type('text/javascript').send(decoderCache);
  });

  // ---------- WebSocket 中继 ----------
  const wss = new WebSocketServer({ noServer: true });

  app.server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/kvm') return; // 其它 upgrade 交给别的处理器

    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    const session = token ? getSession(token) : undefined;
    if (!session) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, session.client, token);
    });
  });

  wss.on('connection', async (ws: WebSocket, _req: unknown, bmc: import('./bmc.js').BmcClient, token: string) => {
    const sendJson = (obj: unknown) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    };
    const sink = {
      send: (obj: unknown) => sendJson(obj),
      sendBinary: (buf: Buffer) => {
        if (ws.readyState === ws.OPEN) ws.send(buf, { binary: true });
      },
    };

    let mouseMode: MouseMode = 'absolute';
    let last: { x: number; y: number } | undefined;
    let hidSent = 0;
    let session: KvmSession | null = null;
    /** 会话是否已被显式断开（浏览器点「断开」），此时不再复用 */
    let userDisconnected = false;

    /** 建一条新会话并接管；失败时重试若干次（BMC 握手偶发失败） */
    const startSession = async (): Promise<KvmSession | null> => {
      const s = new KvmSession(bmc);
      s.on('state', (_state: string, detail: string) =>
        app.log.info(`KVM 状态: ${_state}${detail ? ' — ' + detail : ''}`),
      );
      // 会话为了争取主控会主动断开 → 立刻重建（见 KvmSession.requestFullAccess）
      s.on('closed', () => {
        if (s.restartRequested && !userDisconnected && ws.readyState === ws.OPEN) {
          app.log.info('为争取主控重建 KVM 会话');
          void startSession().then((next) => {
            if (next) session = next;
          });
        }
      });
      live.set(token, s);
      for (let i = 1; i <= 3; i++) {
        try {
          await s.start();
          await new Promise((r) => setTimeout(r, 1200)); // 握手错误常是异步 ws error
          if (s.usable) {
            s.attach(sink);
            app.log.info(`KVM 会话已建立（BMC racsession_id=${bmc.sessionId}）`);
            return s;
          }
        } catch (e) {
          app.log.warn(`KVM 建连失败（第 ${i}/3 次）: ${(e as Error).message}`);
        }
        s.close();
        if (i < 3) await new Promise((r) => setTimeout(r, 1200));
      }
      return null;
    };

    // 已有还活着的 KVM 会话（浏览器刚刷新/重连）→ 直接复用，不再重新握手，
    // 避免 BMC 还没释放旧会话时把新连接判成「从属」（键鼠会失效）
    const existing = live.get(token);
    if (existing?.usable) {
      app.log.info('复用已有 KVM 会话（浏览器重连）');
      session = existing;
      session.attach(sink);
    } else {
      if (existing) live.delete(token);
      const created = await startSession();
      if (!created) {
        const detail = (live.get(token) as KvmSession | undefined)?.detail || 'KVM 连接失败';
        sendJson({ type: 'state', state: 'failed', detail });
        live.delete(token);
        ws.close();
        return;
      }
      session = created;
    }

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!session) return;
      if (isBinary) {
        session.send(data); // 浏览器直接构造的 IVTP 包原样转发
        return;
      }
      let msg: {
        kind?: string;
        mode?: MouseMode;
        modifiers?: number;
        keys?: number[];
        buttons?: number;
        x?: number;
        y?: number;
        wheel?: number;
        screenW?: number;
        screenH?: number;
      };
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      if (msg.kind === 'refresh') {
        session.refresh(); // 让 BMC 重发画面变化区
        return;
      }
      if (msg.kind === 'disconnect') {
        // 浏览器明确断开：直接关掉 BMC 会话，不做 60s 保留（下次连接要的是干净的主控）
        userDisconnected = true;
        live.delete(token);
        session.close();
        return;
      }
      if (msg.kind === 'set-mouse-mode' && (msg.mode === 'absolute' || msg.mode === 'relative')) {
        mouseMode = msg.mode;
        last = undefined;
        sendJson({ type: 'state', state: session.state, detail: `鼠标模式=${mouseMode}` });
        return;
      }
      if (msg.kind === 'keyboard' || msg.kind === 'mouse') {
        const pkt = hidPacket(
          { ...msg, kind: msg.kind } as import('./hid.js').HidInput,
          mouseMode,
          last,
        );
        if (msg.kind === 'mouse') last = { x: msg.x ?? 0, y: msg.y ?? 0 };
        hidSent++;
        // 前几条打出来，方便确认键鼠确实有往外发（不做逐条刷屏）
        if (hidSent <= 12 || hidSent % 200 === 0) {
          app.log.info(
            `HID #${hidSent} ${msg.kind} 报文 ${pkt.length} 字节` +
              (msg.kind === 'keyboard'
                ? ` mod=0x${(msg.modifiers ?? 0).toString(16)} keys=[${(msg.keys ?? []).join(',')}]`
                : ` btn=${msg.buttons ?? 0} (${msg.x},${msg.y}) wheel=${msg.wheel ?? 0} 模式=${mouseMode}`),
          );
        }
        session.send(pkt);
      }
    });

    // 浏览器断开：不立刻关 BMC 会话，留着等重连（见 KvmSession.graceMs 的说明）
    ws.on('close', () => {
      if (!userDisconnected) session?.detach();
    });
    ws.on('error', () => {
      if (!userDisconnected) session?.detach();
    });
  });

  app.addHook('onClose', async () => {
    for (const kvm of live.values()) kvm.close();
    live.clear();
    wss.close();
  });
}

/** 服务停止时也要清掉 BMC 侧会话，供 index.ts 的优雅退出调用 */
export function closeAllKvm() {
  for (const kvm of live.values()) kvm.close();
  live.clear();
}
