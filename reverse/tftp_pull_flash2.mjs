// 重跑 TFTP 拉取，这次持续观察「下载完成之后」BMC 的状态机走到哪一步。
// 上一轮只看到 state=2（下载完成）就停了轮询，漏掉了后续（校验/刷写）的信息——
// 而原版 UI 在 TFTP 分支里 downloadProgress 有参数遮蔽 bug（对字符串调方法），
// 说明这条 UI 路径本身也是坏的，所以必须靠持续轮询看清 BMC 的真实流程。
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

const call = async (label, path, method = 'GET', body) => {
  try {
    const r = await raw(path, { method, headers: { ...H, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    return { status: r.status, text: t };
  } catch (e) {
    return { status: 0, text: e.name };
  }
};

await call('', '/api/maintenance/fwimage_location', 'PUT', { id: 1, protocol_type: 'tftp', server_address: TFTP_SERVER, image_name: IMAGE_NAME, retry_count: 3 });
log('已配置 TFTP 镜像位置');
log('PUT /api/maintenance/flash{flash_type:BMC}（刷写准备）…');
const p1 = await call('', '/api/maintenance/flash', 'PUT', { flash_type: 'BMC' });
log(`   准备 → ${p1.status} ${p1.text.slice(0, 120)}`);
log('PUT /api/maintenance/firmware/dwldfwimg {PROTO_TYPE:1}（让 BMC 去拉）');
const p2 = await call('', '/api/maintenance/firmware/dwldfwimg', 'PUT', { PROTO_TYPE: 1 });
log(`   触发 → ${p2.status} ${p2.text.slice(0, 120)}`);

log('持续轮询（不再因 "Complete" 提前退出）');
let prevD = '', prevF = '';
for (let i = 1; i <= 90; i++) {
  await sleep(8000);
  const d = await call('', '/api/maintenance/firmware/dwldfwstatus-progress');
  const f = await call('', '/api/maintenance/firmware/flash-progress');
  const ds = `${d.status} ${d.text.replace(/\s+/g, ' ').slice(0, 150)}`;
  const fs = `${f.status} ${f.text.replace(/\s+/g, ' ').slice(0, 150)}`;
  if (ds !== prevD) { log(`  [${i}] dwld  ${ds}`); prevD = ds; }
  if (fs !== prevF) { log(`  [${i}] flash ${fs}`); prevF = fs; }
  if (/Failed/i.test(fs) && /Verif|Flash/i.test(fs)) { log('  校验/刷写失败终态'); }
  if (/10[0-9]%|Complete/i.test(fs) && /Flash/i.test(fs)) { log('  刷写看起来已完成'); }
}
stop = true;
log(`结束（保活 ${ka} 次）`);
process.exit(0);
