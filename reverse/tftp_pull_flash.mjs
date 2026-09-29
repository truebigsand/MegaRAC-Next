// 让 BMC 自己通过 TFTP 拉取固件镜像（原版 JS 里的「远程位置」流程）。
// 这是唯一不用 BMC 出站 HTTP 的通道，也是唯一还没试过的通道。
//
// 原版流程（取自 source.min.js 的 downloadstart / downloadFWImage）：
//   1) PUT /api/maintenance/fwimage_location   配置 TFTP 服务器地址与镜像名
//   2) PUT /api/maintenance/flash              {flash_type:"BMC"} 刷写准备
//   3) PUT /api/maintenance/firmware/dwldfwimg {"PROTO_TYPE":1}  1=TFTP，让 BMC 去拉
//   4) GET /api/maintenance/firmware/dwldfwstatus-progress       下载进度（state 1..5）
// 期间每 10 秒 GET /api/maintenance/fwupdate_keepalived 保活。
import { Agent, fetch as uFetch } from 'undici';

const HOST = process.env.BMC_HOST || '192.168.0.200';
const TFTP_SERVER = process.env.TFTP_SERVER || '192.168.0.201';
const IMAGE_NAME = process.env.IMAGE_NAME || 'rom.ima';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const raw = (p, o = {}) => uFetch(`https://${HOST}${p}`, { ...o, dispatcher: agent, signal: AbortSignal.timeout(o.t || 300000) });
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
if (!cookie) { log('无法登录，放弃'); process.exit(1); }
const H = { cookie, 'X-CSRFTOKEN': login.CSRFToken, 'X-Requested-With': 'XMLHttpRequest' };
log('已登录');

let stop = false;
(async () => { while (!stop) { await sleep(10000); try { await raw('/api/maintenance/fwupdate_keepalived', { headers: H, t: 15000 }); } catch {} } })();

const show = async (label, path, method = 'GET', body) => {
  const t0 = Date.now();
  try {
    const r = await raw(path, { method, headers: { ...H, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    log(`${label} ${method} ${path} → ${r.status}（${Math.round((Date.now() - t0) / 1000)}s）${t.slice(0, 300).replace(/\s+/g, ' ')}`);
    return { status: r.status, text: t };
  } catch (e) {
    log(`${label} ${method} ${path} → ${e.name}`);
    return { status: 0, text: '' };
  }
};

// 1) 配置镜像位置
await show('1)', '/api/maintenance/fwimage_location', 'PUT', {
  id: 1, protocol_type: 'tftp', server_address: TFTP_SERVER, image_name: IMAGE_NAME, retry_count: 3,
});
await show('   复读', '/api/maintenance/fwimage_location');

// 2) 刷写准备
await show('2)', '/api/maintenance/flash', 'PUT', { flash_type: 'BMC' });

// 3) 触发下载
await show('3)', '/api/maintenance/firmware/dwldfwimg', 'PUT', { PROTO_TYPE: 1 });

// 4) 轮询下载/刷写进度
log('轮询 dwldfwstatus-progress');
for (let i = 1; i <= 60; i++) {
  await sleep(8000);
  const r = await show(`   [${i}]`, '/api/maintenance/firmware/dwldfwstatus-progress');
  if (r.status === 0) { log('   BMC 可能正在重启（下载完成后会进入刷写）'); }
  const pr = await show('   flash-progress', '/api/maintenance/firmware/flash-progress');
  if (/Failed|Complete|100%/.test(pr.text)) { log('   出现终态，停止轮询'); break; }
}
stop = true;
process.exit(0);
