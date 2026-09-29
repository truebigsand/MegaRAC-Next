// 最后一次尝试：HPM 更新模式 + 经典上传/校验/刷写接口的组合
//   PUT  /api/maintenance/hpm/updatemode        { }                → 进入更新模式（拿到 unique_id）
//   POST /api/maintenance/firmware              fwimage=镜像        → 上传
//   GET  /api/maintenance/firmware/verification?flash_type=BMC     → 校验
//   PUT  /api/maintenance/firmware/upgrade      {…}                → 刷写
// 失败则调用 hpm/exitupdatemode 干净退出，不留残状态。
import { Agent, fetch as uFetch } from 'undici';
import { readFileSync, statSync } from 'node:fs';

const HOST = '192.168.0.200';
const FILE = 'C:/path/to/MegaRAC-Next/bmc_firmware/126139.bin';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const raw = (p, o = {}) => uFetch(`https://${HOST}${p}`, { ...o, dispatcher: agent, signal: AbortSignal.timeout(o.timeoutMs || 900000) });
const json = (p, o = {}) => raw(p, { ...o, headers: { 'content-type': 'application/json', ...(o.headers || {}) } });
const brief = (t) => t.replace(/\s+/g, ' ').slice(0, 240);
const log = (s) => console.log(`[${new Date().toLocaleTimeString('zh-CN')}] ${s}`);

const lr = await raw('/api/session', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username: 'admin', password: process.env.BMC_PASS || '' }).toString(),
});
const login = await lr.json();
if (login.ok !== 0) { log('登录失败'); process.exit(1); }
const cookie = (lr.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
const h = { cookie, 'x-csrftoken': login.CSRFToken };
log('已登录');

let keep = setInterval(() => { json('/api/maintenance/fwupdate_keepalived', { headers: h, timeoutMs: 15000 }).catch(() => {}); }, 10000);
const bail = async (why) => {
  log('回滚：退出更新模式');
  try {
    const e = await json('/api/maintenance/hpm/exitupdatemode', { method: 'PUT', headers: h, body: '{}', timeoutMs: 60000 });
    log(`exitupdatemode → ${e.status} ${brief(await e.text())}`);
  } catch (err) { log('退出失败: ' + err.name); }
  clearInterval(keep);
  log(`结束（${why}）`);
  process.exit(0);
};

// 1) 进入更新模式
const um = await json('/api/maintenance/hpm/updatemode', { method: 'PUT', headers: h, body: '{}', timeoutMs: 180000 });
const umText = await um.text();
log(`1) hpm/updatemode → ${um.status} ${brief(umText)}`);
if (um.status !== 200) await bail('无法进入更新模式');

// 2) 上传
log(`2) 上传 ${statSync(FILE).size} 字节…`);
const fd = new FormData();
fd.append('fwimage', new Blob([readFileSync(FILE)]), '126139.bin');
const up = await raw('/api/maintenance/firmware', { method: 'POST', headers: h, body: fd });
const upText = await up.text();
log(`   上传 → ${up.status} ${brief(upText)}`);
if (up.status !== 200 || upText.includes('Error') || upText.includes('cc')) await bail('上传被拒');

// 3) 校验
const vr = await json('/api/maintenance/firmware/verification?flash_type=BMC', { headers: h, timeoutMs: 180000 });
const vText = await vr.text();
log(`3) 校验 → ${vr.status} ${brief(vText)}`);
if (vr.status !== 200) await bail('校验失败');

// 4) 刷写
const body = { flash_type: 'BMC', preserve_config: 1, flash_status: 1 };
const sr = await json('/api/maintenance/firmware/upgrade', { method: 'PUT', headers: h, body: JSON.stringify(body), timeoutMs: 240000 });
const sText = await sr.text();
log(`4) 刷写 → ${sr.status} ${brief(sText)}`);
if (sr.status !== 200) await bail('刷写未启动');

log('5) 轮询进度（BMC 将重启）…');
for (let i = 0; i < 200; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  try {
    const pr = await json('/api/maintenance/firmware/flash-progress', { headers: h, timeoutMs: 20000 });
    const d = await pr.json();
    log(`   ${JSON.stringify(d).slice(0, 200)}`);
    if (/complete|100/i.test(String(d.progress))) break;
  } catch {
    log('   BMC 无响应 → 正在重启');
    break;
  }
}
clearInterval(keep);
log('脚本结束');
process.exit(0);
