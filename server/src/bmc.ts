// BMC 客户端：持有单个 BMC 会话，所有请求串行化。
// 会话协议见 docs/API.md 第 0 节。
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';

const BMC_BASE = process.env.BMC_BASE || 'https://192.168.0.200';
// 该 BMC 正常响应 2~3 秒，偶发长尾会超过 15 秒，故放宽并配合重试
const REQUEST_TIMEOUT_MS = Number(process.env.BMC_TIMEOUT_MS || 30_000);
/** 瞬时故障（超时/连接被中断）时 GET 的重试次数；写操作不重试，避免重复提交 */
const GET_ATTEMPTS = 3;
/** 串行队列里最多允许多少个请求在排队（超出直接拒绝，避免雪崩） */
const MAX_QUEUED = Number(process.env.BMC_MAX_QUEUED || 8);
/**
 * 两次登录之间的最小间隔（毫秒）。
 * ⚠️ 必须有：BMC 的 401 会触发"重登再试"，而前端是定时轮询的——
 * 一旦出现"登录成功但请求仍 401"的状态，就会形成**疯狂建会话的死循环**，
 * 实测十几分钟就把 BMC 那 148 格的会话表打满，之后连登录都被拒
 * （并且把 KVM 服务拖坏）。冷却 + 连续失败熔断是止血关键。
 */
const LOGIN_COOLDOWN_MS = Number(process.env.BMC_LOGIN_COOLDOWN_MS || 15_000);
/** 连续多少次确诊"重登也救不回来"后就熔断（停止自动重登，等用户重新登录） */
const MAX_CONSECUTIVE_RELOGIN_FAILURES = 3;

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
  /** 上次登录时间与并发合并（见 LOGIN_COOLDOWN_MS 的说明） */
  private lastLoginAt = 0;
  private loginInFlight: Promise<void> | null = null;
  /** 连续"重登后仍然 401"的次数，达到上限就熔断 */
  private reloginFailures = 0;

  constructor(username: string, password: string) {
    this.username = username;
    this.password = password;
  }

  /** 当前排队等待的请求数（用于诊断与限流） */
  private queued = 0;

  /**
   * 串行化：同一时刻只有一个请求在飞，保护 BMC 极小的并发会话配额。
   *
   * ⚠️ 但必须限制**排队等待**：BMC 慢时单个请求可能十几秒，
   * 若来者不拒地排队，前端轮询会越堆越多并反过来把 BMC 压得更慢（实测踩过）。
   * 等待超过 QUEUE_WAIT_LIMIT_MS 就直接失败，让调用方稍后重试。
   */
  private run<T>(fn: () => Promise<T>, priority = false): Promise<T> {
    // 只有「轮询型」请求会被限流；登录/写操作/KVM 建连这类**用户主动触发**的请求走优先通道，
    // 否则 BMC 一慢就会被后台轮询挤掉（实测 KVM 建连被 bmc_busy 拒过）。
    if (!priority && this.queued >= MAX_QUEUED) {
      return Promise.reject(new Error('bmc_busy: 排队请求过多，请稍后重试'));
    }
    this.queued++;
    const next = this.queue.then(fn, fn).finally(() => {
      this.queued--;
    });
    this.queue = next.catch(() => {});
    return next;
  }

  /** 排队中的请求数 */
  get queueDepth(): number {
    return this.queued;
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
    // 合并并发登录：多个请求同时发现 401 时只登一次
    if (this.loginInFlight) return this.loginInFlight;
    // 冷却：15 秒内不重复登录，避免 401 循环把 BMC 会话表打满
    const since = Date.now() - this.lastLoginAt;
    if (since < LOGIN_COOLDOWN_MS) {
      throw new Error(`bmc_login_throttled: 登录过于频繁（${Math.ceil((LOGIN_COOLDOWN_MS - since) / 1000)}s 后重试）`);
    }
    const p = this.doLogin();
    this.loginInFlight = p;
    try {
      await p;
    } finally {
      this.loginInFlight = null;
    }
  }

  private async doLogin(): Promise<void> {
    this.lastLoginAt = Date.now();
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
    this.reloginFailures = 0;
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
      // 熔断：连续多次"重登也救不回"说明不是过期，而是账号/会话槽位问题，
      // 继续自动重登只会疯狂建会话（见 LOGIN_COOLDOWN_MS）
      if (this.reloginFailures >= MAX_CONSECUTIVE_RELOGIN_FAILURES) {
        this.loggedIn = false;
        throw new BmcSessionExpiredError();
      }
      try {
        await this.login();
        res = await this.rawRequest(method, path, opts);
      } catch {
        this.reloginFailures++;
        this.loggedIn = false;
        throw new BmcSessionExpiredError();
      }
      if (res.status === 401) {
        this.reloginFailures++;
        throw new BmcSessionExpiredError();
      }
      this.reloginFailures = 0; // 成功一次就清零
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

  /** GET 数据端点（只读）。默认走限流通道；priority=true 时优先放行 */
  get(path: string, priority = false): Promise<BmcResult> {
    return this.run(() => this.authorized('GET', path), priority);
  }

  /** 写操作转发（POST/PUT/DELETE），由前端确认对话框把关 */
  
  send(method: 'POST' | 'PUT' | 'DELETE', path: string, json?: unknown): Promise<BmcResult> {
    return this.run(() => this.authorized(method, path, { json }), true);
  }

  get sessionId(): number {
    return this.racSessionId;
  }
}

/**
 * 取 BMC 上的静态资源（KVM 解码 worker 等）。
 * 这些文件在 BMC 上不需要登录即可下载，直接走同一套免校验 Agent。
 */
export async function fetchBmcAsset(
  path: string,
): Promise<{ status: number; contentType: string; body: Buffer }> {
  const res = await undiciFetch(BMC_BASE + path, {
    dispatcher: agent as unknown as Dispatcher,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    body,
  };
}
