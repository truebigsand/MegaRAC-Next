// 监控 BMC 在镜像下载完成后的校验/刷写进度，直到它重启并回来。
// 刷写期间会经历：校验 → 擦写 flash → 重启 → 新固件上线。
import { Agent, fetch as uFetch } from 'undici';

const HOST = process.env.BMC_HOST || '192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const raw = (p, o = {}) => uFetch(`https://${HOST}${p}`, { ...o, dispatcher: agent, signal: AbortSignal.timeout(o.t || 20000) });
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const login = async () => {
  const lr = await raw('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: process.env.BMC_PASS }).toString(),
  });
  const t = await lr.text();
  let j = {};
  try { j = JSON.parse(t); } catch {}
  const ck = (lr.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  return lr.status === 200 && j.ok === 0 ? { cookie: ck, csrf: j.CSRFToken } : null;
};

let H = await login();
log(H ? '已登录，开始监控' : '登录被拒（可能正在刷写），先只看 Redfish 存活');

const t0 = Date.now();
let lastMsg = '';
let sawDown = false;
let downAt = 0;
for (let i = 1; i <= 200; i++) {
  await sleep(10000);
  const el = Math.round((Date.now() - t0) / 1000);

  // 1) Redfish 存活（BMC 是否在重启）
  let alive = false;
  try { const r = await raw('/redfish/v1', { t: 8000 }); await r.text(); alive = r.status === 200; } catch {}
  if (!alive) { sawDown = true; downAt = downAt || el; }
  if (sawDown && alive) { log(`[${el}s] ★ BMC 已重启回来（下线于 ${downAt}s）`); }

  // 2) 经典 web 进度
  if (!H) { H = await login(); if (H) log(`[${el}s] 重新登录成功`); }
  if (H) {
    try {
      const r = await raw('/api/maintenance/firmware/flash-progress', { headers: { cookie: H.cookie, 'X-CSRFTOKEN': H.csrf, 'X-Requested-With': 'XMLHttpRequest' } });
      const j = await r.json();
      const msg = `action="${j.action}" progress="${j.progress}" state=${j.state}`;
      if (msg !== lastMsg) { log(`[${el}s] ${msg}`); lastMsg = msg; }
      if (/Failed/i.test(String(j.progress))) { log(`[${el}s] ✗ 失败终态，停止监控`); break; }
    } catch (e) {
      if (sawDown && alive) { /* 重启后会话失效，正常 */ }
    }
  }

  // 3) 实时版本（能拿到就说明一切正常）
  if (i % 3 === 0) {
    try {
      const r = await raw('/redfish/v1/SessionService/Sessions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ UserName: 'admin', Password: process.env.BMC_PASS }), t: 15000,
      });
      const tok = r.headers.get('x-auth-token');
      if (tok) {
        const d = await (await raw('/redfish/v1/Managers/Self', { headers: { 'x-auth-token': tok }, t: 20000 })).json();
        if (d.FirmwareVersion) log(`[${el}s] 当前固件: ${d.FirmwareVersion}`);
      }
    } catch {}
  }

  if (el > 1500) { log('监控超时结束'); break; }
}
process.exit(0);
