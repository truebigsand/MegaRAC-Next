// ⚠️ 用完务必注销：该 BMC 的 web 会话上限很小（148），泄漏会占满后
// 导致登录被拒（Maximum number of sessions already in use）且 KVM 升级被降级。
import { Agent, fetch as uFetch } from 'undici';
const BMC = 'https://192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const fetch = (u, o = {}) => uFetch(u, { ...o, dispatcher: agent });
const res = await fetch(BMC + '/api/session', {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username: 'admin', password: 'REDACTED_BMC_PASSWORD' }).toString(),
});
const data = JSON.parse(await res.text());
const h = { cookie: (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; '), 'x-csrftoken': data.CSRFToken };
const svc = await (await fetch(BMC + '/api/settings/services', { headers: h })).json();
const list = Array.isArray(svc) ? svc : (svc.services ?? []);
console.log('服务总数', list.length);
for (const s of list) {
  const name = s.service_name ?? s.name ?? '?';
  if (/kvm|video|media|web/i.test(String(name))) console.log(JSON.stringify(s));
}
const cfg = await (await fetch(BMC + '/api/settings/media/h5viewercfg', { headers: h })).json();
console.log('kvm_service_status =', cfg.kvm_service_status, ' num_cd =', cfg.num_cd, ' num_hd =', cfg.num_hd);
