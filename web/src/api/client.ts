// 统一 API 客户端。
//
// 与改造前的区别：
//   · 新增 `apiGet`——访问**归一化接口**（/api/overview、/api/sensors、/api/sel、/api/inventory），
//     这些由代理把「经典 web API + Redfish 增补」揉好了，页面不再各自解析裸字段；
//   · `bmcGet` / `bmcSend` 保留——风扇曲线、设置页写操作、KVM 仍需要原始通道；
//   · 错误统一成 `ApiError`（带 status），页面能区分「未登录」与「BMC 忙/慢」，
//     不再把所有错误都当成"会话过期"而把用户踢回登录页。
import { onUnauthorized } from '../store';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  /** 未登录 / BMC 会话失效 */
  get isAuth(): boolean {
    return this.status === 401;
  }
  /** 代理拒绝了请求（例如 BMC 忙、排队过多）——重试即可 */
  get isBusy(): boolean {
    return this.status === 502 || this.status === 503 || this.status === 429;
  }
}

async function handle(res: Response): Promise<unknown> {
  if (res.status === 401) {
    // 只有明确"未登录"才把用户踢回登录页；BMC 侧的短暂问题不应该让用户重登
    let code = '';
    let detail = '';
    try {
      const body = (await res.json()) as { error?: string; detail?: string };
      code = body.error ?? '';
      detail = body.detail ?? '';
    } catch {
      /* 非 JSON */
    }
    if (code === 'not_logged_in' || code === 'bmc_session_expired') onUnauthorized();
    // 带上代理给的具体原因（例如"BMC 的 web 会话表已满"）——这跟"登录超时"是两回事
    const msg = code === 'not_logged_in' ? '未登录' : detail || 'BMC 会话已过期，请重新登录';
    throw new ApiError(msg, 401, code);
  }
  if (!res.ok) {
    let detail = '';
    let code = '';
    try {
      const data = (await res.json()) as { error?: string; detail?: string };
      code = data.error ?? '';
      detail = data.error ? (data.detail ? `${data.error}: ${data.detail}` : data.error) : '';
    } catch {
      /* 非 JSON 错误体 */
    }
    throw new ApiError(detail || `请求失败（HTTP ${res.status}）`, res.status, code);
  }
  return res.json();
}

/**
 * 进行中的 GET（按 URL 去重）。
 * BMC 慢的时候一次请求可能要十几秒，而各页面是定时轮询的——不去重就会在代理的
 * 串行队列里越堆越多，反过来把 BMC 压得更慢（实测踩过）。
 */
const inflightGets = new Map<string, Promise<unknown>>();

export async function dedupGet<T>(url: string): Promise<T> {
  const existing = inflightGets.get(url);
  if (existing) return existing as Promise<T>;
  const p = (async () => handle(await fetch(url)))().finally(() => inflightGets.delete(url));
  inflightGets.set(url, p);
  return (await p) as T;
}

// ---------------------------------------------------------------- 认证

export async function login(username: string, password: string): Promise<void> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  await handle(res);
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' });
  onUnauthorized();
}

// ---------------------------------------------------------------- 归一化接口（新 UI 主入口）

/** 归一化数据（代理已把经典 API 与 Redfish 揉好） */
export function apiGet<T>(path: string): Promise<T> {
  return dedupGet<T>(path);
}

// ---------------------------------------------------------------- 原始 BMC 通道（风扇曲线 / 设置写操作 / KVM）

export function bmcGet<T>(path: string): Promise<T> {
  return dedupGet<T>('/bmc/' + path.replace(/^\/?api\//, ''));
}

export async function bmcSend<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await fetch('/bmc/' + path.replace(/^\/?api\//, ''), {
    method,
    // 无 body 时不能带 JSON content-type，否则服务端会拒绝空 body
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await handle(res)) as T;
}

/** 代理自身的接口（非 BMC 转发），如 /api/history* */
export function localGet<T>(path: string): Promise<T> {
  return dedupGet<T>(path);
}
