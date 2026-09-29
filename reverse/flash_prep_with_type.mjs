// 关键差异验证：原版 downloadstart 里 PUT /api/maintenance/flash 的 body 是 {flash_type:"BMC"}，
// 而此前几次尝试发的是空 {}。如果刷写区是按组件类型准备的，这就是上传被瞬间拒绝的原因。
// 本脚本按原版形态（body 带 flash_type）重新走一遍，只做 准备 → 上传 → 校验，不触发刷写。
import { Agent, fetch as uFetch } from 'undici';
import { readFileSync, statSync } from 'node:fs';

const HOST = process.env.BMC_HOST || '192.168.0.200';
const FILE = process.env.FW_FILE || 'bmc_firmware/126139.bin';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const raw = (p, o = {}) => uFetch(`https://${HOST}${p}`, { ...o, dispatcher: agent, signal: AbortSignal.timeout(o.t || 900000) });
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

// 登录（BMC 在刷写/校验失败后会重启 web 栈，登录可能被 reset/拒绝，需容错重试）
let login = {}, cookie = '';
for (let i = 1; i <= 30; i++) {
  try {
    const lr = await raw('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: process.env.BMC_PASS }).toString(),
    });
    const t = await lr.text();
    try { login = JSON.parse(t); } catch { login = {}; }
    if (lr.status === 200 && login.ok === 0) { cookie = (lr.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; '); break; }
    log(`登录 ${lr.status} ${t.slice(0, 110)} —— 等 15s（第 ${i} 次）`);
  } catch (e) {
    log(`登录异常 ${e.name}${e.cause ? '/' + e.cause.code : ''} —— 等 15s（第 ${i} 次）`);
  }
  await new Promise((r) => setTimeout(r, 15000));
}
if (!cookie) { log('一直无法登录'); process.exit(1); }
const H = { cookie, 'X-CSRFTOKEN': login.CSRFToken, 'X-Requested-With': 'XMLHttpRequest' };
log('已登录');

// 保活
let stop = false;
(async () => { while (!stop) { await new Promise((r) => setTimeout(r, 10000)); try { await raw('/api/maintenance/fwupdate_keepalived', { headers: H, t: 15000 }); } catch {} } })();

// 1) 刷写准备：body 带 flash_type（原版形态）
log('PUT /api/maintenance/flash  body={"flash_type":"BMC"}');
const fm = await raw('/api/maintenance/flash', {
  method: 'PUT', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ flash_type: 'BMC' }),
});
log(`   → ${fm.status} ${(await fm.text()).slice(0, 200)}`);

// 2) 上传真镜像
const stat = statSync(FILE);
log(`POST /api/maintenance/firmware（${stat.size} 字节）`);
const t0 = Date.now();
const fd = new FormData();
fd.append('fwimage', new Blob([readFileSync(FILE)], { type: 'application/octet-stream' }), '126139.bin');
const up = await raw('/api/maintenance/firmware', { method: 'POST', headers: H, body: fd });
const upTxt = await up.text();
log(`   → ${up.status}（${Math.round((Date.now() - t0) / 1000)}s）`);
log(`   响应: ${upTxt.slice(0, 500)}`);

// 3) 校验（无论上传响应如何都查，因为 BMC 是异步做「Image Verification」的）
log('查询 flash-progress / verification');
for (let i = 1; i <= 12; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  try {
    const pr = await raw('/api/maintenance/firmware/flash-progress', { headers: H, t: 30000 });
    const pt = await pr.text();
    log(`   [${i}] flash-progress ${pr.status} ${pt.slice(0, 200)}`);
    if (pt.includes('Failed') || pt.includes('Complete') || pt.includes('100')) break;
  } catch (e) {
    log(`   [${i}] flash-progress 异常 ${e.name}`);
  }
}
try {
  const vf = await raw('/api/maintenance/firmware/verification?flash_type=BMC', { headers: H, t: 120000 });
  const vt = await vf.text();
  log(`   verification → ${vf.status} ${vt.slice(0, 400)}`);
  const s = JSON.parse(vt)?.[0]?.verification_status;
  if (typeof s === 'number') {
    const bits = [];
    for (const [b, n] of [[1, 'FORCE_FLASH'], [2, 'SECTION_CMP'], [4, 'VERSION_CMP'], [16, 'FULL_FLASH'], [32, 'VER_SAME'], [64, 'SIZE_DIFF']]) if (s & b) bits.push(`${b}=${n}`);
    log(`   verification_status=${s} → ${bits.join(', ') || '(无位)'}`);
  }
} catch (e) {
  log(`   verification 异常 ${e.name}`);
}
stop = true;
process.exit(0);
