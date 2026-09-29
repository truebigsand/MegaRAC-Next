// BMC 固件升级（原厂 web API 完整流程，实测顺序）：
//   0) PUT  /api/maintenance/flash                       进入刷写模式（必需前置，否则报 "Can't set options."）
//   1) POST /api/maintenance/firmware                    multipart 字段 fwimage 上传镜像
//   2) GET  /api/maintenance/firmware/verification      校验（签名/完整性）
//   3) PUT  /api/maintenance/firmware/upgrade            开始刷写
//      body {flash_type:'BMC', preserve_config:1, flash_status:1}  ← 1 = CONS_FORCE_FLASH（整镜像）
//   4) GET  /api/maintenance/firmware/flash-progress     进度
//      GET  /api/maintenance/fwupdate_keepalived        每 10s 保活（超 90s BMC 会放弃）
//
// 刷写期间 BMC 重启，主机与虚拟机不受影响。
import { Agent, fetch as uFetch } from 'undici';
import { readFileSync, statSync, writeFileSync } from 'node:fs';

const HOST = process.env.BMC_HOST || '192.168.0.200';
const FILE = process.env.FW_FILE || 'C:/path/to/MegaRAC-Next/bmc_firmware/126139.bin';
const PRESERVE = process.env.PRESERVE_CONFIG !== '0';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const raw = (p, o = {}) => uFetch(`https://${HOST}${p}`, { ...o, dispatcher: agent, signal: AbortSignal.timeout(o.timeoutMs || 900000) });
const json = (p, o = {}) => raw(p, { ...o, headers: { 'content-type': 'application/json', ...(o.headers || {}) } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => {
  const line = `[${new Date().toLocaleTimeString('zh-CN')}] ${s}`;
  console.log(line);
};

const logins = [];
const lr = await raw('/api/session', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username: process.env.BMC_USER || 'admin', password: process.env.BMC_PASS || '' }).toString(),
});
const login = await lr.json();
if (lr.status !== 200 || login.ok !== 0) {
  log(`登录失败 ${lr.status} ${JSON.stringify(login).slice(0, 120)}`);
  process.exit(1);
}
const cookie = (lr.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
const h = { cookie, 'x-csrftoken': login.CSRFToken };
log('已登录 web API');

// 保活
let keepaliveCount = 0;
const keepalive = setInterval(async () => {
  try {
    await json('/api/maintenance/fwupdate_keepalived', { headers: h, timeoutMs: 15000 });
    keepaliveCount++;
  } catch {
    /* BMC 重启期间会失败，忽略 */
  }
}, 10000);

const t0 = Date.now();
// 0) 进入刷写模式
log('0) 进入刷写模式 PUT /api/maintenance/flash');
const fm = await raw('/api/maintenance/flash', { method: 'PUT', headers: { ...h, 'content-type': 'application/json' }, body: '{}' });
log(`   → ${fm.status} ${(await fm.text()).slice(0, 120)}`);
if (fm.status !== 200) { clearInterval(keepalive); process.exit(2); }

// 1) 上传
const stat = statSync(FILE);
log(`1) 上传 ${FILE}（${(stat.size / 1048576).toFixed(1)} MiB）…`);
const fd = new FormData();
fd.append('fwimage', new Blob([readFileSync(FILE)]), '126139.bin');
const up = await raw('/api/maintenance/firmware', { method: 'POST', headers: h, body: fd });
const upText = await up.text();
log(`   上传 → ${up.status}（${Math.round((Date.now() - t0) / 1000)}s）${upText ? ' ' + upText.replace(/\s+/g, ' ').slice(0, 200) : ''}`);
if (up.status !== 200 || !/^\s*\{\s*\}/.test(upText) && upText.includes('Error')) {
  log('   上传未成功，终止（BMC 会保持在刷写模式，必要时用 IPMI 重置）');
  clearInterval(keepalive);
  process.exit(3);
}

// 2) 校验
log('2) 校验镜像');
let verify = null;
for (let i = 0; i < 20; i++) {
  try {
    const vr = await json('/api/maintenance/firmware/verification?flash_type=BMC', { headers: h, timeoutMs: 180000 });
    const t = await vr.text();
    log(`   校验 → ${vr.status} ${t.slice(0, 300)}`);
    if (vr.status === 200) { verify = t; break; }
  } catch (e) {
    log(`   第 ${i + 1} 次校验未就绪（${e.name}）`);
  }
  await sleep(5000);
}
if (!verify) { log('   校验未通过，终止'); clearInterval(keepalive); process.exit(4); }
writeFileSync('C:/path/to/MegaRAC-Next/reverse/firmware_verification.json', verify);
const vStatus = (() => { try { const d = JSON.parse(verify); return Array.isArray(d) ? d[0]?.verification_status : d.verification_status; } catch { return undefined; } })();
log(`   verification_status = ${vStatus}`);

// 3) 开始刷写
const body = { flash_type: 'BMC', preserve_config: PRESERVE ? 1 : 0, flash_status: 1 };
log(`3) 开始刷写 ${JSON.stringify(body)}`);
const sr = await json('/api/maintenance/firmware/upgrade', { method: 'PUT', headers: h, body: JSON.stringify(body), timeoutMs: 240000 });
log(`   → ${sr.status} ${(await sr.text()).slice(0, 200)}`);
if (sr.status !== 200) { log('   刷写未启动，终止'); clearInterval(keepalive); process.exit(5); }

// 4) 轮询
log('4) 轮询进度（BMC 将在此后重启）…');
let last = '';
for (let i = 0; i < 240; i++) {
  await sleep(5000);
  try {
    const pr = await json('/api/maintenance/firmware/flash-progress', { headers: h, timeoutMs: 20000 });
    const d = await pr.json();
    const key = `${d.progress}|${d.action ?? ''}`;
    if (key !== last) { log(`   ${JSON.stringify(d).slice(0, 220)}`); last = key; }
    if (/complete/i.test(String(d.progress)) || String(d.progress).includes('100')) { log('   进度完成，等待重启'); break; }
  } catch (e) {
    log(`   BMC 无响应（${e.name}）→ 通常在重启`);
    break;
  }
}
clearInterval(keepalive);
log(`保活发了 ${keepaliveCount} 次；脚本结束，接下来等 BMC 回来核对版本。`);
process.exit(0);
