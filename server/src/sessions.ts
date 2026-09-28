import { BmcClient } from './bmc.js';

export interface BrowserSession {
  token: string;
  client: BmcClient;
  createdAt: number;
}

/** 浏览器会话 → BMC 客户端映射（一个浏览器会话对应一个 BMC 会话，凭证仅驻内存） */
const sessions = new Map<string, BrowserSession>();

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

export function sessionCount(): number {
  return sessions.size;
}

export function allSessions(): BrowserSession[] {
  return [...sessions.values()];
}
