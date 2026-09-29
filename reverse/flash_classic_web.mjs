// BMC 固件升级（经典 web API 路径）——严格照抄原版 UI 的请求形态。
//
// 从 reverse/source.min.js 里读出的真实流程（FirmwareUpgradeView）：
//   1) PUT  /api/maintenance/flash                       刷写准备（成功后才上传）
//   2) POST /api/maintenance/firmware                    multipart 字段名 fwimage；失败时 UI 用 setInterval 反复重试
//   3) GET  /api/maintenance/firmware/verification?flash_type=BMC   校验，返回 verification_status 位掩码
//   4) PUT  /api/maintenance/firmware/upgrade             {flash_type:'BMC', preserve_config:1, flash_status:1}
//   5) GET  /api/maintenance/firmware/flash-progress      进度；期间 GET /api/maintenance/fwupdate_keepalived 保活
//
// 请求头细节（此前失败很可能就栽在这里）：
//   · CSRF 头名原版是 X-CSRFTOKEN（$.ajaxSetup 全局设置），必须大小写一致
//   · jQuery 会额外带 X-Requested-With: XMLHttpRequest
//   · 登录请求体是 x-www-form-urlencoded，不是 JSON
//
// 刷写期间 BMC 重启；主机与虚拟机不受影响。
import { Agent, fetch as uFetch } from 'undici';
import { readFileSync, statSync } from 'node:fs';

const HOST = process.env.BMC_HOST || '192.168.0.200';
const FILE = process.env.FW_FILE || 'bmc_firmware/126139.bin';
const PRESERVE = process.env.PRESERVE_CONFIG !== '0';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const raw = (p, o = {}) => uFetch(`https://${HOST}${p}`, { ...o, dispatcher: agent, signal: AbortSignal.timeout(o.t || 120000) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${stamp()}]`, ...a);

// 1) 登录
// BMC 处于「Firmware update is in progress」(code 17000) 时会拒登录——这是上一次
// 进了刷写模式却没走完留下的状态，原版没有退出接口，只能等 BMC 自己超时（约 45~90 秒）。
let login = {};
let cookie = '';
for (let i = 1; i <= 20; i++) {
  const lr = await raw('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: process.env.BMC_USER || 'admin', password: process.env.BMC_PASS || '' }).toString(),
  });
  const txt = await lr.text();
  try {
    login = JSON.parse(txt);
  } catch {
    login = {};
  }
  if (lr.status === 200 && login.ok === 0) {
    cookie = (lr.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    break;
  }
  if (login.code === 17000) {
    log(`BMC 处于「固件更新进行中」状态，第 ${i} 次等待 15 秒后重试…`);
    await sleep(15000);
    continue;
  }
  log('登录失败', lr.status, txt.slice(0, 200));
  process.exit(1);
}
if (!cookie) {
  log('BMC 一直未退出「固件更新进行中」状态，放弃（可考虑 IPMI 冷复位）');
  process.exit(1);
}
const baseHeaders = {
  cookie,
  'X-CSRFTOKEN': login.CSRFToken,
  'X-Requested-With': 'XMLHttpRequest',
};
log('已登录（cookie + X-CSRFTOKEN + X-Requested-With 已备齐）');

// 保活：刷写期间每 10 秒一次，超过 90 秒没有保活 BMC 会放弃
let kaCount = 0;
let kaStop = false;
const ka = (async () => {
  while (!kaStop) {
    await sleep(10000);
    try {
      await raw('/api/maintenance/fwupdate_keepalived', { headers: baseHeaders, t: 15000 });
      kaCount++;
    } catch {
      /* BMC 重启期间失败属正常 */
    }
  }
})();

// 2) 刷写准备
log('1) PUT /api/maintenance/flash（刷写准备）');
const fm = await raw('/api/maintenance/flash', {
  method: 'PUT',
  headers: { ...baseHeaders, 'content-type': 'application/json' },
  body: '{}',
});
log(`   → ${fm.status} ${(await fm.text()).slice(0, 200)}`);
// 1304 = 刷写区已准备过（上一次尝试留下的状态）。这不是错误，可以直接继续。
if (fm.status !== 200) {
  const t = await raw('/api/maintenance/flash', { method: 'PUT', headers: { ...baseHeaders, 'content-type': 'application/json' }, body: '{}' });
  log(`   复检 PUT flash → ${t.status} ${(await t.text()).slice(0, 160)}`);
  if (t.status !== 200) {
    log('刷写准备失败，终止');
    kaStop = true;
    process.exit(2);
  }
}

// 3) 上传镜像（照原版：失败就重试，最多 3 次）
const stat = statSync(FILE);
log(`2) 上传 ${FILE}（${stat.size} 字节）`);
let uploaded = false;
for (let attempt = 1; attempt <= 3 && !uploaded; attempt++) {
  const fd = new FormData();
  fd.append('fwimage', new Blob([readFileSync(FILE)], { type: 'application/octet-stream' }), '126139.bin');
  const t0 = Date.now();
  try {
    const r = await raw('/api/maintenance/firmware', { method: 'POST', headers: baseHeaders, body: fd, t: 900000 });
    const txt = await r.text();
    log(`   第 ${attempt} 次 → ${r.status} (${Math.round((Date.now() - t0) / 1000)}s) ${txt.slice(0, 300)}`);
    let ok = false;
    try {
      const j = JSON.parse(txt);
      ok = j.cc === 0 || (j.cc === undefined && !j.error);
    } catch {}
    uploaded = r.status === 200 && ok;
    if (!uploaded) {
      log(`   上传未通过，判定应答：${JSON.stringify(txt.slice(0, 120))}`);
      await sleep(3000);
    }
  } catch (e) {
    log(`   第 ${attempt} 次异常 ${e.name}: ${e.message}`);
    await sleep(3000);
  }
}
if (!uploaded) {
  log('上传失败，终止（BMC 未改动；刷写模式会在 45~90 秒内自行退出）');
  kaStop = true;
  process.exit(3);
}
log('   上传成功 ✓');

// 4) 校验
const vf = await raw('/api/maintenance/firmware/verification?flash_type=BMC', { headers: baseHeaders, t: 300000 });
const vtxt = await vf.text();
log(`3) verification → ${vf.status} ${vtxt.slice(0, 400)}`);

// 位掩码含义（取自原版 FirmwareUpgradeView）：
//   1=CONS_FORCE_FLASH 2=CONS_SECTION_CMP_FLASH 4=CONS_VERSION_CMP_FLASH
//   16=CONS_FULL_FLASH 32=VERSION_CMP_MODULE_VERSION_SAME 64=VERSION_CMP_MODULE_SIZE_DIFF
try {
  const v = JSON.parse(vtxt);
  const s = v?.[0]?.verification_status;
  if (typeof s === 'number') {
    const bits = [];
    for (const [bit, name] of [[1, 'FORCE_FLASH'], [2, 'SECTION_CMP'], [4, 'VERSION_CMP'], [16, 'FULL_FLASH'], [32, 'VER_SAME'], [64, 'SIZE_DIFF']]) {
      if (s & bit) bits.push(`${bit}=${name}`);
    }
    log(`   verification_status = ${s} → ${bits.join(', ') || '(无位)'}`);
  }
} catch {}

if (process.env.STOP_AFTER_VERIFY === '1') {
  log('STOP_AFTER_VERIFY=1：已按要求在上传+校验后停下，未发起刷写。');
  kaStop = true;
  process.exit(0);
}

// 5) 开始刷写
const upBody = { flash_type: 'BMC', preserve_config: PRESERVE ? 1 : 0, flash_status: 1 };
log('4) PUT /api/maintenance/firmware/upgrade', JSON.stringify(upBody));
const up = await raw('/api/maintenance/firmware/upgrade', {
  method: 'PUT',
  headers: { ...baseHeaders, 'content-type': 'application/json' },
  body: JSON.stringify(upBody),
  t: 300000,
});
log(`   → ${up.status} ${(await up.text()).slice(0, 300)}`);

// 6) 轮询进度
log('5) 轮询 flash-progress（BMC 稍后重启会失联，属正常）');
for (let i = 1; i <= 60; i++) {
  await sleep(10000);
  try {
    const r = await raw('/api/maintenance/firmware/flash-progress', { headers: baseHeaders, t: 20000 });
    const t = await r.text();
    log(`   #${i} ${r.status} ${t.slice(0, 200)}`);
    const j = JSON.parse(t);
    const p = String(j.progress || '');
    if (p === 'Complete' || p === '100% done' || p === '100') {
      log('   进度报告完成 ✓');
      break;
    }
  } catch (e) {
    log(`   #${i} 异常 ${e.name} —— BMC 很可能正在重启`);
  }
}
kaStop = true;
log(`结束（保活发了 ${kaCount} 次）。BMC 重启后核对版本。`);
process.exit(0);
