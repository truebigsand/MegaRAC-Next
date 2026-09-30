// Redfish 客户端（只读为主）。
//
// 为什么单独写一个、而不是合并进 bmc.ts：
//   Redfish 与经典 web API 是**两套独立的会话体系**（Redfish 用 x-auth-token，
//   经典用 QSESSIONID cookie），且两者的故障特征完全不同。
//
// 这台 BMC（12.61.39）上实测出来的三条铁律，本文件全部围绕它们设计：
//   1. **绝不能 abort 请求**。客户端一旦超时取消，BMC 侧会把该会话"毒死"：
//      后续请求要么挂住、要么返回 401 `the service was denied access`。
//      所以超时给得很长（默认 90 秒），而且判定失败后**换会话**而不是在同会话上重试。
//   2. **有些资源会挂**（实测 /redfish/v1/Chassis 挂满 120 秒，而同一份传感器数据
//      经典 web API 只要 193ms）——所以 Redfish 只做增补，不能当作 UI 的唯一数据源，
//      并且每个资源都要能单独降级（熔断后不再打它，直接回退到经典源）。
//   3. **别打太快**。新固件有防滥用保护，实测密集请求（几十次/几秒）会触发
//      HTTP 层封禁（连登录都 403），约 3 分钟后自愈。所以请求串行 + 最小间隔 + 限流令牌桶。
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';

export const BMC_BASE = process.env.BMC_BASE || 'https://192.168.0.200';
/** 单请求超时：必须给足。见铁律 1——abort 会毒死会话，宁可慢也不能掐。 */
const TIMEOUT_MS = Number(process.env.RF_TIMEOUT_MS || 90_000);
/** 两次 Redfish 请求之间的最小间隔（毫秒） */
const MIN_INTERVAL_MS = Number(process.env.RF_MIN_INTERVAL_MS || 250);
/** 令牌桶：窗口内最多多少请求（防滥用） */
const BUCKET_WINDOW_MS = 10_000;
const BUCKET_MAX = Number(process.env.RF_BUCKET_MAX || 25);
/** 命中防滥用封禁后的退避时长（实测约 3 分钟自愈，这里取保守值） */
const ABUSE_BACKOFF_MS = Number(process.env.RF_ABUSE_BACKOFF_MS || 200_000);
/** 某资源连续失败多少次后熔断（之后一段时间直接走回退源，不再打它） */
const BREAK_AFTER = 2;
const BREAK_MS = Number(process.env.RF_BREAK_MS || 300_000);

const agent = new Agent({ connect: { rejectUnauthorized: false } });

export interface RedfishStat {
  ok: boolean;
  reason: string;
  token: boolean;
  lastOkAt: number;
  requests: number;
  failures: number;
  relogins: number;
  abuseBlockedUntil: number;
  broken: Record<string, number>;
}

interface CacheEntry {
  at: number;
  data: unknown;
}

export class RedfishClient {
  private username = '';
  private password = '';
  private token = '';
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;
  private windowStart = 0;
  private windowCount = 0;
  private cache = new Map<string, CacheEntry>();
  /** 每个资源的连续失败次数（熔断用） */
  private failures = new Map<string, number>();
  private brokenUntil = new Map<string, number>();
  private abuseBlockedUntil = 0;
  private relogins = 0;
  private requests = 0;
  private failureCount = 0;
  private lastOkAt = 0;
  private lastReason = 'idle';
  private loginInFlight: Promise<boolean> | null = null;

  configure(username: string, password: string) {
    if (this.username === username && this.password === password) return;
    // 凭证换了 → 旧会话作废（不主动 DELETE：BMC 那边会随会话超时自己回收）
    this.username = username;
    this.password = password;
    this.token = '';
  }

  get available(): boolean {
    return !!this.username && !!this.password;
  }

  stat(): RedfishStat {
    return {
      ok: !!this.token && this.abuseBlockedUntil < Date.now(),
      reason: this.lastReason,
      token: !!this.token,
      lastOkAt: this.lastOkAt,
      requests: this.requests,
      failures: this.failureCount,
      relogins: this.relogins,
      abuseBlockedUntil: this.abuseBlockedUntil,
      broken: Object.fromEntries([...this.brokenUntil.entries()].filter(([, t]) => t > Date.now())),
    };
  }

  /** 命中防滥用封禁时，下一次允许请求的时间 */
  private get throttled(): boolean {
    return Date.now() < this.abuseBlockedUntil;
  }

  // 熔断按**精确路径**记：实测 /redfish/v1/Systems 与 /redfish/v1/Systems/Self 一个是好的、
  // 一个会挂，按父路径归组会把好的那个也一起熔断掉（踩过）。
  private isBroken(path: string): boolean {
    return (this.brokenUntil.get(path) ?? 0) > Date.now();
  }

  private markFailure(path: string, reason: string) {
    this.failureCount++;
    this.lastReason = reason;
    const n = (this.failures.get(path) ?? 0) + 1;
    this.failures.set(path, n);
    if (n >= BREAK_AFTER) {
      this.brokenUntil.set(path, Date.now() + BREAK_MS);
      this.failures.set(path, 0);
      this.lastReason = `${reason}（${path} 已熔断 ${Math.round(BREAK_MS / 1000)}s）`;
    }
  }

  private markOk() {
    this.lastOkAt = Date.now();
    this.lastReason = 'ok';
    for (const k of [...this.failures.keys()]) this.failures.set(k, 0);
  }

  /** 限流 + 串行化：所有 Redfish 请求都经过这里 */
  private schedule<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      const now = Date.now();
      // 令牌桶
      if (now - this.windowStart > BUCKET_WINDOW_MS) {
        this.windowStart = now;
        this.windowCount = 0;
      }
      if (this.windowCount >= BUCKET_MAX) {
        const wait = BUCKET_WINDOW_MS - (now - this.windowStart) + 50;
        await new Promise((r) => setTimeout(r, wait));
        this.windowStart = Date.now();
        this.windowCount = 0;
      }
      this.windowCount++;
      // 最小间隔
      const gap = Date.now() - this.lastRequestAt;
      if (gap < MIN_INTERVAL_MS) await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - gap));
      this.lastRequestAt = Date.now();
      this.requests++;
      return fn();
    });
    this.queue = next.catch(() => {});
    return next;
  }

  /** 建会话。登录本身也可能挂（实测偶发），所以单独给一次重试机会。 */
  private async doLogin(): Promise<boolean> {
    if (this.loginInFlight) return this.loginInFlight;
    this.loginInFlight = (async () => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const res = await undiciFetch(`${BMC_BASE}/redfish/v1/SessionService/Sessions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ UserName: this.username, Password: this.password }),
            dispatcher: agent as unknown as Dispatcher,
            signal: AbortSignal.timeout(Math.min(TIMEOUT_MS, 45_000)),
          });
          const text = await res.text();
          const tok = res.headers.get('x-auth-token');
          if (tok) {
            this.token = tok;
            this.relogins++;
            this.lastReason = 'ok';
            return true;
          }
          // 403 且是 HTML → 防滥用封禁
          if (res.status === 403 && text.includes('<html')) {
            this.abuseBlockedUntil = Date.now() + ABUSE_BACKOFF_MS;
            this.lastReason = `BMC 防滥用封禁中（约 ${Math.round(ABUSE_BACKOFF_MS / 60000)} 分钟）`;
            this.token = '';
            return false;
          }
          this.lastReason = `Redfish 登录失败 ${res.status}: ${text.slice(0, 120)}`;
        } catch (e) {
          this.lastReason = `Redfish 登录异常 ${(e as Error).name}`;
        }
        if (attempt < 2) await new Promise((r) => setTimeout(r, 3000));
      }
      this.token = '';
      return false;
    })().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  /**
   * 取一个 Redfish 资源。
   * @param path 形如 /redfish/v1/Managers/Self
   * @param ttlMs 缓存有效期（0 = 不缓存）
   * @param timeoutMs 本次请求的超时覆盖值。背景任务用较短超时（挂着的代价更小，
   *                  且弄脏会话只影响它自己）；用户可见的请求保持默认的长超时。
   * @returns 成功返回 body；失败抛出（调用方应回退到经典源）
   */
  async get<T = unknown>(path: string, ttlMs = 5000, timeoutMs?: number): Promise<T> {
    if (!this.available) throw new Error('redfish_not_configured');
    if (this.throttled) throw new Error(`redfish_abuse_backoff: ${this.lastReason}`);
    if (this.isBroken(path)) throw new Error(`redfish_broken: ${path}`);

    const cached = this.cache.get(path);
    if (cached && ttlMs > 0 && Date.now() - cached.at < ttlMs) return cached.data as T;

    return this.schedule(async () => {
      if (!this.token && !(await this.doLogin())) throw new Error(`redfish_no_session: ${this.lastReason}`);
      let res: Awaited<ReturnType<typeof undiciFetch>>;
      try {
        res = await undiciFetch(BMC_BASE + path, {
          headers: { 'x-auth-token': this.token },
          dispatcher: agent as unknown as Dispatcher,
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs ?? TIMEOUT_MS),
        });
      } catch (e) {
        // 超时/连接错：会话大概率已被毒死，丢掉 token 下次重登
        this.token = '';
        this.markFailure(path, `请求异常 ${(e as Error).name}`);
        throw e;
      }
      const text = await res.text();
      if (res.status === 200) {
        let data: unknown = null;
        try {
          data = JSON.parse(text);
        } catch {
          this.markFailure(path, '响应不是 JSON');
          throw new Error('redfish_bad_json');
        }
        this.cache.set(path, { at: Date.now(), data });
        this.markOk();
        return data as T;
      }
      if (res.status === 403 && text.includes('<html')) {
        this.abuseBlockedUntil = Date.now() + ABUSE_BACKOFF_MS;
        this.token = '';
        this.markFailure(path, '防滥用封禁');
        throw new Error('redfish_abuse_backoff');
      }
      if (res.status === 401 || res.status === 403) {
        // 会话作废 → 换会话；本次失败
        this.token = '';
        this.markFailure(path, `被拒 ${res.status}`);
        throw new Error(`redfish_denied:${res.status}`);
      }
      this.markFailure(path, `HTTP ${res.status}`);
      throw new Error(`redfish_http_${res.status}`);
    });
  }

  /** 拿缓存（不发起请求）——降级时用来兜底 */
  peek<T = unknown>(path: string): T | null {
    const c = this.cache.get(path);
    return c ? (c.data as T) : null;
  }

  /** 关闭会话（代理退出时调用） */
  async close(): Promise<void> {
    if (!this.token) return;
    const tok = this.token;
    this.token = '';
    try {
      await undiciFetch(`${BMC_BASE}/redfish/v1/SessionService/Sessions/${tok}`, {
        method: 'DELETE',
        headers: { 'x-auth-token': tok },
        dispatcher: agent as unknown as Dispatcher,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      /* 尽力而为 */
    }
  }
}

export const redfish = new RedfishClient();
