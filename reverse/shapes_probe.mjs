import { Agent, fetch as uFetch } from 'undici';
// ⚠️ 需要 BMC 凭据：先设置环境变量 BMC_PASS 再运行
const PASS = process.env.BMC_PASS || '';
const HOST = '192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const fetch = (u, o = {}) => uFetch(u, { ...o, dispatcher: agent, signal: AbortSignal.timeout(25000) });
const res = await fetch(`https://${HOST}/api/session`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username: 'admin', password: PASS }).toString(),
});
const t = await res.text();
if (res.status !== 200) { console.log('登录', res.status, t.slice(0, 80)); process.exit(1); }
const d = JSON.parse(t);
const h = { cookie: (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; '), 'x-csrftoken': d.CSRFToken };
for (const p of ['settings/users', 'settings/network', 'settings/date-time']) {
  const r = await fetch(`https://${HOST}/api/${p}`, { headers: h });
  const body = await r.text();
  console.log(`\n=== ${p} (${r.status}) ===`);
  console.log(body.slice(0, 900));
}
await fetch(`https://${HOST}/api/session`, { method: 'DELETE', headers: h }).catch(() => {});
process.exit(0);
