// 测 BMC 的**有效并发会话上限**：连续登录，看第几次被拒；每次都记录会话数并注销。
import { Agent, fetch as uFetch } from 'undici';
// ⚠️ 需要 BMC 凭据：先设置环境变量 BMC_PASS 再运行
const PASS = process.env.BMC_PASS || '';
const HOST = '192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const fetch = (u, o = {}) => uFetch(u, { ...o, dispatcher: agent });
const login = async () => {
  const res = await fetch(`https://${HOST}/api/session`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: PASS }).toString(),
  });
  const text = await res.text();
  return {
    status: res.status, text: text.slice(0, 70),
    cookie: (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; '),
    csrf: (() => { try { return JSON.parse(text).CSRFToken; } catch { return ''; } })(),
  };
};
const held = [];
for (let i = 1; i <= 4; i++) {
  const r = await login();
  console.log(`第 ${i} 次登录: ${r.status} ${r.text}`);
  if (r.status !== 200) break;
  held.push(r);
  const arr = await (await fetch(`https://${HOST}/api/settings/service-sessions`, {
    headers: { cookie: r.cookie, 'x-csrftoken': r.csrf } })).json().catch(() => null);
  console.log(`   当前会话列表长度: ${Array.isArray(arr) ? arr.length : JSON.stringify(arr).slice(0, 60)}`);
}
// 全部注销
for (const h of held) {
  try { await fetch(`https://${HOST}/api/session`, { method: 'DELETE', headers: { cookie: h.cookie, 'x-csrftoken': h.csrf } }); } catch {}
}
console.log(`已注销 ${held.length} 个`);
process.exit(0);
