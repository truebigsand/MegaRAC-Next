// 等 BMC 的 web 会话表腾出空位（表满时连登录都会被拒）。
import { Agent, fetch as uFetch } from 'undici';
// ⚠️ 需要 BMC 凭据：先设置环境变量 BMC_PASS 再运行
const PASS = process.env.BMC_PASS || '';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const fetch = (u, o = {}) => uFetch(u, { ...o, dispatcher: agent });
const BMC = 'https://192.168.0.200';
const MAX_MS = Number(process.argv[2] || 9 * 60_000);
const t0 = Date.now();
while (Date.now() - t0 < MAX_MS) {
  const res = await fetch(BMC + '/api/session', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: PASS }).toString(),
  });
  const text = await res.text();
  const stamp = new Date().toLocaleTimeString('zh-CN');
  if (res.status === 200) {
    const data = JSON.parse(text);
    const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const arr = await (await fetch(BMC + '/api/settings/service-sessions', {
      headers: { cookie, 'x-csrftoken': data.CSRFToken } })).json();
    console.log(`[${stamp}] ✓ 登录成功，当前会话数 ${Array.isArray(arr) ? arr.length : '?'}`);
    await fetch(BMC + '/api/session', { method: 'DELETE', headers: { cookie, 'x-csrftoken': data.CSRFToken } });
    process.exit(0);
  }
  console.log(`[${stamp}] ✗ ${res.status} ${text.slice(0, 70)}`);
  await new Promise((r) => setTimeout(r, 30_000));
}
console.log('等待超时');
process.exit(1);
