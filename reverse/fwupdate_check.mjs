// 原版固件升级页进页首件事：GET /api/maintenance/fwupdate_check，
// status==1 即 BMC 自认为「正在升级固件」——用来判断刷写状态机是否卡住。
import { Agent, fetch as uFetch } from 'undici';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const raw = (p, o = {}) => uFetch(`https://192.168.0.200${p}`, { ...o, dispatcher: agent, signal: AbortSignal.timeout(o.t || 40000) });
const lr = await raw('/api/session', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username: 'admin', password: process.env.BMC_PASS }).toString(),
});
const txt = await lr.text();
console.log('登录 →', lr.status, txt.slice(0, 220));
let login = {};
try { login = JSON.parse(txt); } catch {}
const ck = (lr.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
console.log('cookie:', ck ? '有' : '无', '| CSRFToken:', login.CSRFToken || '(无)');
if (!ck) process.exit(1);
const h = { cookie: ck, 'x-csrftoken': login.CSRFToken || '' };
for (const p of ['/api/maintenance/fwupdate_check', '/api/maintenance/firmware/flash-progress']) {
  const t0 = Date.now();
  try {
    const r = await raw(p, { headers: h });
    console.log(`\n${p} → ${r.status} ${Date.now() - t0}ms`);
    console.log('   ', (await r.text()).slice(0, 300));
  } catch (e) { console.log(`\n${p} → ${e.name} ${Date.now() - t0}ms`); }
}
await raw('/api/session', { method: 'DELETE', headers: h }).catch(() => {});
process.exit(0);
