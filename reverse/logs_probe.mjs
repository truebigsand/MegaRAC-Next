// ⚠️ 用完务必注销：该 BMC 的 web 会话上限很小（148），泄漏会占满后
// 导致登录被拒（Maximum number of sessions already in use）且 KVM 升级被降级。
import { Agent, fetch as uFetch } from 'undici';
// ⚠️ 需要 BMC 凭据：先设置环境变量 BMC_PASS 再运行
const PASS = process.env.BMC_PASS || '';
const BMC = 'https://192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const fetch = (u, o = {}) => uFetch(u, { ...o, dispatcher: agent });
const res = await fetch(BMC + '/api/session', {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username: 'admin', password: PASS }).toString(),
});
const data = JSON.parse(await res.text());
const h = { cookie: (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; '), 'x-csrftoken': data.CSRFToken };
for (const [label, path] of [['audit', '/api/logs/audit'], ['event', '/api/logs/event']]) {
  try {
    const r = await fetch(BMC + path, { headers: h });
    const j = await r.json();
    const arr = Array.isArray(j) ? j : (j.records ?? j.logs ?? j.entries ?? []);
    console.log(`\n=== ${label} (${r.status}) 共 ${arr.length} 条，末 8 条 ===`);
    for (const e of arr.slice(-8)) console.log(JSON.stringify(e).slice(0, 220));
  } catch (e) { console.log(label, '失败', e.message); }
}
