import { BmcClient } from './bmc.js';

export interface BrowserSession {
  token: string;
  client: BmcClient;
  createdAt: number;
}

/** 浏览器会话 → BMC 客户端映射（凭证仅驻内存） */
const sessions = new Map<string, BrowserSession>();

/**
 * 同一个 BMC 账号**共用一个 BMC 会话**（按用户名池化）。
 *
 * 为什么必须共享：
 *  1) 该 BMC 的 web 会话表很小（148），一个浏览器标签一条会飞快占满，
 *     满了之后连登录都被拒（`Maximum number of sessions already in use`）——
 *     实测踩过，只能靠 IPMI 冷重置 BMC 才救回来。
 *  2) 同账号再登录会让 BMC 判定先前那条会话失效（实测旧会话请求返回
 *     `Invalid Authentication`），所以"每个浏览器标签各登一次"本来也互相踢。
 * 共享后：N 个浏览器标签 = 1 条 BMC 会话，且刷新页面不会新建会话。
 */
const pool = new Map<string, BmcClient>();

export function acquireClient(username: string, password: string): BmcClient {
  const existing = pool.get(username);
  if (existing?.loggedIn) return existing;
  const client = new BmcClient(username, password);
  pool.set(username, client);
  return client;
}

/** 释放某账号的共享会话（显示退出时用） */
export function releaseClient(username: string): BmcClient | undefined {
  const client = pool.get(username);
  pool.delete(username);
  return client;
}

export function pooledClients(): BmcClient[] {
  return [...pool.values()];
}

export function createSession(token: string, client: BmcClient): void {
  sessions.set(token, { token, client, createdAt: Date.now() });
}

export function getSession(token: string | undefined): BrowserSession | undefined {
  if (!token) return undefined;
  return sessions.get(token);
}

export function dropSession(token: string): BrowserSession | undefined {
  const s = sessions.get(token);
  sessions.delete(token);
  return s;
}

/** 某个账号是否还有浏览器会话在用（没有则共享的 BMC 会话可以注销） */
export function hasSessionFor(username: string): boolean {
  for (const s of sessions.values()) if (s.client.username === username) return true;
  return false;
}

export function sessionCount(): number {
  return sessions.size;
}

export function allSessions(): BrowserSession[] {
  return [...sessions.values()];
}
