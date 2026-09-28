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

export async function bmcGet<T>(path: string): Promise<T> {
  const res = await fetch('/bmc/' + path.replace(/^\/?api\//, ''));
  return (await handle(res)) as T;
}

/** 代理自身提供的接口（非 BMC 转发），如 /api/history* */
export async function localGet<T>(path: string): Promise<T> {
  const res = await fetch(path);
  return (await handle(res)) as T;
}

export async function bmcSend<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await fetch('/bmc/' + path.replace(/^\/?api\//, ''), {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await handle(res)) as T;
}
