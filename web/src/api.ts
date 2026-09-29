import { onUnauthorized } from './store';

async function handle(res: Response): Promise<unknown> {
  if (res.status === 401) {
    onUnauthorized();
    throw new Error('未登录或 BMC 会话已过期');
  }
  if (!res.ok) {
    let detail = '';
    try {
      const data = (await res.json()) as { error?: string; detail?: string };
      detail = data.error ? (data.detail ? `${data.error}: ${data.detail}` : data.error) : '';
    } catch {
      /* 非 JSON 错误体 */
    }
    throw new Error(detail || `请求失败（HTTP ${res.status}）`);
  }
  return res.json();
}

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

/**
 * 进行中的 GET（按 URL 去重）。
 * BMC 慢的时候一次请求可能要十几秒，而各页面是定时轮询的（最短 3s）——
 * 不去重就会在代理的串行队列里越堆越多，反过来把 BMC 压得更慢（实测踩过）。
 * 同一个 GET 还没回来时，后续调用直接复用它的 Promise。
 */
const inflightGets = new Map<string, Promise<unknown>>();

export async function bmcGet<T>(path: string): Promise<T> {
  const url = '/bmc/' + path.replace(/^\/?api\//, '');
  const existing = inflightGets.get(url);
  if (existing) return existing as Promise<T>;
  const p = (async () => {
    const res = await fetch(url);
    return handle(res);
  })().finally(() => inflightGets.delete(url));
  inflightGets.set(url, p);
  return (await p) as T;
}

/** 代理自身提供的接口（非 BMC 转发），如 /api/history* */
export async function localGet<T>(path: string): Promise<T> {
  const res = await fetch(path);
  return (await handle(res)) as T;
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
