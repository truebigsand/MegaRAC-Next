// BMC 客户端：持有单个 BMC 会话，所有请求串行化。
// 会话协议见 docs/API.md 第 0 节。
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';

const BMC_BASE = process.env.BMC_BASE || 'https://192.168.0.200';
// 该 BMC 正常响应 2~3 秒，偶发长尾会超过 15 秒，故放宽并配合重试
const REQUEST_TIMEOUT_MS = Number(process.env.BMC_TIMEOUT_MS || 30_000);
/** 瞬时故障（超时/连接被中断）时 GET 的重试次数；写操作不重试，避免重复提交 */
const GET_ATTEMPTS = 3;

// BMC 用自签证书，仅对发往 BMC 的请求关闭校验
const agent = new Agent({ connect: { rejectUnauthorized: false } });

export interface BmcResult {
  status: number;
  body: unknown;
  text: string;
}

export class BmcSessionExpiredError extends Error {
  constructor() {
    super('bmc_session_expired');
  }
}

export class BmcClient {
  readonly username: string;
  private readonly password: string;
  private csrf = '';
  private cookie = '';
  private racSessionId = 0;
  loggedIn = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(username: string, password: string) {
    this.username = username;
    this.password = password;
  }

  /** 串行化：同一时刻只有一个请求在飞，保护 BMC 极小的并发会话配额 */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  private async rawRequest(
    method: string,
    path: string,
    opts: { json?: unknown; form?: string; contentType?: string } = {},
  ): Promise<BmcResult> {
    const headers: Record<string, string> = {};
    if (this.csrf) headers['x-csrftoken'] = this.csrf;
    if (this.cookie) headers.cookie = this.cookie;
    let body: string | undefined;
    if (opts.form !== undefined) {
      body = opts.form;
      headers['content-type'] = opts.contentType ?? 'application/x-www-form-urlencoded';
    } else if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      headers['content-type'] = 'application/json';
    }

    const attempts = method === 'GET' ? GET_ATTEMPTS : 1;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await undiciFetch(BMC_BASE + path, {
          method,
          headers,
          body,
          dispatcher: agent as unknown as Dispatcher,
          redirect: 'manual',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const text = await res.text();
        const setCookie = res.headers.getSetCookie?.() ?? [];
        if (setCookie.length) {
          this.cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
        }
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        return { status: res.status, body: parsed, text };
      } catch (e) {
        lastErr = e;
        if (attempt < attempts) await new Promise((r) => setTimeout(r, 700 * attempt));
      }
    }
    throw lastErr;
  }

  async login(): Promise<void> {
    const form = new URLSearchParams({ username: this.username, password: this.password });
    const res = await this.rawRequest('POST', '/api/session', { form: form.toString() });
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(res.text) as Record<string, unknown>;
    } catch {
      /* 非 JSON（可能返回 HTML）按失败处理 */
    }
    if (res.status !== 200 || data.ok !== 0 || typeof data.CSRFToken !== 'string') {
      const err = new Error(data.error ? String(data.error) : `BMC 登录失败（HTTP ${res.status}）`);
      throw err;
    }
    this.csrf = data.CSRFToken;
    this.racSessionId = Number(data.racsession_id ?? 0);
    this.loggedIn = true;
  }

  async logout(): Promise<void> {
    if (!this.loggedIn) return;
    try {
      await this.rawRequest('DELETE', '/api/session');
    } catch {
      /* 注销失败不影响本地清理 */
    }
    this.loggedIn = false;
  }

  private async authorized(method: string, path: string, opts: { json?: unknown } = {}): Promise<BmcResult> {
    if (!this.loggedIn) throw new BmcSessionExpiredError();
    let res = await this.rawRequest(method, path, opts);
    // 会话失效时 BMC 返回 401 {"cc":7,"error":"Invalid Authentication"}（实测）；
    // 403 多为资源/权限性拒绝（例如 KVM 会话槽满），因此只把 401 视为会话失效。
    if (res.status === 401) {
      try {
        await this.login();
        res = await this.rawRequest(method, path, opts);
      } catch {
        this.loggedIn = false;
        throw new BmcSessionExpiredError();
      }
      // 重登后仍然 401：会话已不可恢复（调用方会据此丢弃浏览器会话，让用户重新登录）
      if (res.status === 401) throw new BmcSessionExpiredError();
    } else if (res.status === 403) {
      // 403 顺带重登一次再试（老固件可能以此表示会话失效）；仍为 403 则视为资源性拒绝原样返回
      try {
        await this.login();
        const retry = await this.rawRequest(method, path, opts);
        if (retry.status !== 403) res = retry;
      } catch {
        /* 重登失败也按 403 原样返回，不误判为会话失效 */
      }
    }
    return res;
  }

  /** GET 数据端点（只读） */
  get(path: string): Promise<BmcResult> {
    return this.run(() => this.authorized('GET', path));
  }

  /**
   * 写操作转发（POST/PUT/DELETE）。
   * ⚠️ 项目纪律：开发阶段不对真实 BMC 触发写操作——
   * 这条通道本身已实现，但调用方（前端按钮）上线验证前保持不接通。
   */
  send(method: 'POST' | 'PUT' | 'DELETE', path: string, json?: unknown): Promise<BmcResult> {
    return this.run(() => this.authorized(method, path, { json }));
  }

  get sessionId(): number {
    return this.racSessionId;
  }
}
