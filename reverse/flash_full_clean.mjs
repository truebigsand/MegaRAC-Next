// 最后一次尝试：干净状态下完整走一遍经典刷写流程。
//
// 之所以要冷复位：实测发现 BMC 的刷写区一旦被某次上传「占位」（其大小随之固定），
// 之后再传不同尺寸的镜像会被**瞬间拒绝**（表现为 0 秒返回 {cc:-1}），
// 前面几次失败（包括 1KB 假文件）都是这个原因，而不是请求形态问题。
//
// 步骤：IPMI 冷复位 → 等 BMC 回来 → PUT flash{flash_type:BMC} → 上传 126139.bin
//       → 轮询 flash-progress 看「Image Verification」的结果
// 期间每 10 秒发一次 fwupdate_keepalived 保活（超 90 秒没保活 BMC 会放弃）。
import { Agent, fetch as uFetch } from 'undici';
import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const HOST = process.env.BMC_HOST || '192.168.0.200';
const FILE = process.env.FW_FILE || 'bmc_firmware/126139.bin';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const raw = (p, o = {}) => uFetch(`https://${HOST}${p}`, { ...o, dispatcher: agent, signal: AbortSignal.timeout(o.t || 900000) });
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1) 冷复位 ----
if (process.env.SKIP_RESET !== '1') {
  log('IPMI 冷复位 BMC（主机与虚拟机不受影响）…');
  const r = spawnSync('python', ['-c', `
from pyghmi.ipmi import command
import os
c = command.Command(bmc='${HOST}', userid='admin', password=os.environ.get('BMC_PASS',''), timeout=20)
print('powerstate', c.get_power().get('powerstate'))
c.reset_bmc()
print('reset sent')
`], { env: process.env, encoding: 'utf8', timeout: 60000 });
  log('  ' + (r.stdout || r.stderr || '').trim().replace(/\n/g, ' | '));

  log('等 BMC 下线再上线…');
  const t0 = Date.now();
  let sawDown = false;
  while (Date.now() - t0 < 420000) {
    let up = false;
    try { const x = await raw('/redfish/v1', { t: 6000 }); await x.text(); up = x.status === 200; } catch {}
    if (!up) sawDown = true;
    if (sawDown && up) { log(`  BMC 已回来（${Math.round((Date.now() - t0) / 1000)}s）`); break; }
    await sleep(5000);
  }
  await sleep(20000); // 让各服务起齐
}

// ---- 2) 登录（带容错）----
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
  await sleep(15000);
}
if (!cookie) { log('始终无法登录，放弃'); process.exit(1); }
const H = { cookie, 'X-CSRFTOKEN': login.CSRFToken, 'X-Requested-With': 'XMLHttpRequest' };
log('已登录');

let stop = false;
(async () => { let n = 0; while (!stop) { await sleep(10000); try { await raw('/api/maintenance/fwupdate_keepalived', { headers: H, t: 15000 }); n++; } catch {} } })();

// ---- 3) 刷写准备 ----
log('PUT /api/maintenance/flash  body={"flash_type":"BMC"}');
const tPrep = Date.now();
const fm = await raw('/api/maintenance/flash', { method: 'PUT', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ flash_type: 'BMC' }) });
log(`   → ${fm.status}（${Math.round((Date.now() - tPrep) / 1000)}s）${(await fm.text()).slice(0, 200)}`);

// ---- 4) 上传 ----
const stat = statSync(FILE);
log(`POST /api/maintenance/firmware（${stat.size} 字节）`);
const t0 = Date.now();
const fd = new FormData();
fd.append('fwimage', new Blob([readFileSync(FILE)], { type: 'application/octet-stream' }), '126139.bin');
const up = await raw('/api/maintenance/firmware', { method: 'POST', headers: H, body: fd });
const upTxt = await up.text();
log(`   → ${up.status}（${Math.round((Date.now() - t0) / 1000)}s）响应: ${upTxt.slice(0, 300).replace(/\s+/g, ' ')}`);

// ---- 5) 看校验结果 ----
log('轮询 flash-progress');
let verdict = '(未判定)';
for (let i = 1; i <= 30; i++) {
  await sleep(8000);
  try {
    const pr = await raw('/api/maintenance/firmware/flash-progress', { headers: H, t: 30000 });
    const pt = await pr.text();
    const j = JSON.parse(pt);
    log(`   [${i}] action="${j.action}" progress="${j.progress}" state=${j.state}`);
    if (/Verif/i.test(j.action || '')) verdict = `${j.action} → ${j.progress}`;
    if (/Failed|Complete|100/.test(String(j.progress))) break;
  } catch (e) { log(`   [${i}] 异常 ${e.name}`); }
}
log(`校验判定: ${verdict}`);
stop = true;
process.exit(0);
