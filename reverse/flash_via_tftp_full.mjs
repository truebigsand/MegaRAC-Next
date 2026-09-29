// 完整走通「TFTP 拉取 → 校验 → 写 flash」流程。
//
// 这条链路是实测唯一能走通的：BMC 自己来 TFTP 取镜像（下载 66 MB 约 90 秒，实测完成），
// 但 BMC 不会自行接着刷——下载完停在 state=2，必须再显式触发校验与 upgrade。
// （原版 UI 在 TFTP 分支的 downloadProgress 有参数遮蔽 bug，所以 UI 也走不完这一步。）
//
// 参数取值来自原版 FirmwareUpgradeView：
//   preserve_config=1 = 保留全部配置（#idpreserveAll 勾选时的值）
//   flash_status=1    = CONS_FORCE_FLASH，整镜像刷写
// 期间每 10 秒发一次 fwupdate_keepalived 保活（超 90 秒没保活 BMC 会放弃）。
import { Agent, fetch as uFetch } from 'undici';

const HOST = process.env.BMC_HOST || '192.168.0.200';
const TFTP_SERVER = process.env.TFTP_SERVER || '192.168.0.201';
const IMAGE_NAME = process.env.IMAGE_NAME || 'rom.ima';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const raw = (p, o = {}) => uFetch(`https://${HOST}${p}`, { ...o, dispatcher: agent, signal: AbortSignal.timeout(o.t || 300000) });
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let login = {}, cookie = '';
for (let i = 1; i <= 40; i++) {
  try {
    const lr = await raw('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: process.env.BMC_PASS }).toString(),
    });
    const t = await lr.text();
    try { login = JSON.parse(t); } catch { login = {}; }
    if (lr.status === 200 && login.ok === 0) { cookie = (lr.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; '); break; }
    log(`登录 ${lr.status} ${t.slice(0, 100)} —— 等 15s（第 ${i} 次）`);
  } catch (e) {
    log(`登录异常 ${e.name}${e.cause ? '/' + e.cause.code : ''} —— 等 15s（第 ${i} 次）`);
  }
  await sleep(15000);
}
if (!cookie) { log('无法登录，放弃'); process.exit(1); }
const H = { cookie, 'X-CSRFTOKEN': login.CSRFToken, 'X-Requested-With': 'XMLHttpRequest' };
log('已登录');

let stop = false;
let ka = 0;
(async () => { while (!stop) { await sleep(10000); try { await raw('/api/maintenance/fwupdate_keepalived', { headers: H, t: 15000 }); ka++; } catch {} } })();

const call = async (path, method = 'GET', body) => {
  try {
    const r = await raw(path, { method, headers: { ...H, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    return { status: r.status, text: t };
  } catch (e) {
    return { status: 0, text: e.name };
  }
};
const short = (s) => s.replace(/\s+/g, ' ').slice(0, 200);

// ---- 1) 配置 TFTP 位置 ----
let r = await call('/api/maintenance/fwimage_location', 'PUT', { id: 1, protocol_type: 'tftp', server_address: TFTP_SERVER, image_name: IMAGE_NAME, retry_count: 3 });
log(`1) 配置镜像位置 → ${r.status} ${short(r.text)}`);

// ---- 2) 刷写准备 ----
log('2) PUT /api/maintenance/flash {flash_type:"BMC"}');
r = await call('/api/maintenance/flash', 'PUT', { flash_type: 'BMC' });
log(`   → ${r.status} ${short(r.text)}`);

// ---- 3) 触发下载并等到完成 ----
log('3) PUT /api/maintenance/firmware/dwldfwimg {PROTO_TYPE:1}');
r = await call('/api/maintenance/firmware/dwldfwimg', 'PUT', { PROTO_TYPE: 1 });
log(`   → ${r.status} ${short(r.text)}`);

let downloaded = false;
for (let i = 1; i <= 60; i++) {
  await sleep(8000);
  const d = await call('/api/maintenance/firmware/dwldfwstatus-progress');
  if (d.status !== 200) { log(`   [${i}] dwld ${d.status} ${short(d.text)}`); continue; }
  let j = {};
  try { j = JSON.parse(d.text); } catch {}
  if (i % 3 === 0 || /Complete|Failed/i.test(String(j.progress))) log(`   [${i}] ${short(d.text)}`);
  if (/Complete/i.test(String(j.progress))) { downloaded = true; log('   ✓ 镜像下载完成'); break; }
  if (/Failed/i.test(String(j.progress))) { log('   ✗ 下载失败'); break; }
}
if (!downloaded) { log('下载未完成，终止'); stop = true; process.exit(2); }

// ---- 4) 校验 ----
log('4) GET /api/maintenance/firmware/verification?flash_type=BMC');
r = await call('/api/maintenance/firmware/verification?flash_type=BMC');
log(`   → ${r.status} ${short(r.text)}`);
try {
  const s = JSON.parse(r.text)?.[0]?.verification_status;
  if (typeof s === 'number') {
    const bits = [];
    for (const [b, n] of [[1, 'FORCE_FLASH'], [2, 'SECTION_CMP'], [4, 'VERSION_CMP'], [16, 'FULL_FLASH'], [32, 'VER_SAME'], [64, 'SIZE_DIFF']]) if (s & b) bits.push(`${b}=${n}`);
    log(`   verification_status=${s} → ${bits.join(', ') || '(无位)'}`);
  }
} catch {}

// ---- 5) 发起刷写 ----
const body = { flash_type: 'BMC', preserve_config: 1, flash_status: 1 };
log('5) PUT /api/maintenance/firmware/upgrade', JSON.stringify(body));
r = await call('/api/maintenance/firmware/upgrade', 'PUT', body);
log(`   → ${r.status} ${short(r.text)}`);

// ---- 6) 监控刷写（BMC 会重启，失联属正常）----
log('6) 监控 flash-progress');
let prev = '';
const t0 = Date.now();
for (let i = 1; i <= 120; i++) {
  await sleep(8000);
  const f = await call('/api/maintenance/firmware/flash-progress');
  const s = `${f.status} ${short(f.text)}`;
  if (s !== prev) { log(`   [${i}] ${s}`); prev = s; }
  // 版本探针
  if (i % 5 === 0) {
    try {
      const rr = await raw('/redfish/v1/SessionService/Sessions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ UserName: 'admin', Password: process.env.BMC_PASS }), t: 20000,
      });
      const tok = rr.headers.get('x-auth-token');
      if (tok) {
        const d = await (await raw('/redfish/v1/Managers/Self', { headers: { 'x-auth-token': tok }, t: 25000 })).json();
        if (d.FirmwareVersion) {
          log(`   当前固件: ${d.FirmwareVersion}`);
          if (d.FirmwareVersion !== '12.41.11') { log('   ★★ 固件版本已变化，升级成功 ★★'); break; }
        }
      }
    } catch {}
  }
  if (Date.now() - t0 > 900000) { log('   监控超时'); break; }
}
stop = true;
log(`结束（保活 ${ka} 次）`);
process.exit(0);
