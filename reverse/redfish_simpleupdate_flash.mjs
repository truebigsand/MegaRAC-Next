// 通过 Redfish UpdateService.SimpleUpdate 升级 BMC 固件（BMC 主动来 HTTP 服务器拉镜像）。
// 参数规格来自 BMC 自己宣告的 SimpleUpdateActionInfo：
//   ImageURI(必填) / TransferProtocol(必填, HTTP|FTP) / User / Password
//   / UpdateComponent(BMC|BIOS|MB_CPLD|BPB_CPLD) / ResetBMC(bool)
// target 是 /redfish/v1/UpdateService/Actions/SimpleUpdate（AMI 用短形式，写成 UpdateService.SimpleUpdate 会 404）
//
// 刷写期间 BMC 会重启：网络/Web/KVM 全部短暂失联，主机与虚拟机不受影响。
// 用法: BMC_PASS=... IMG_URL=http://192.168.0.101:8899/126139.bin node reverse/redfish_simpleupdate_flash.mjs
import { Agent, fetch as uFetch } from 'undici';
import fs from 'node:fs';

const HOST = process.env.BMC_HOST || '192.168.0.200';
const IMAGE = process.env.IMG_URL || 'http://192.168.0.101:8899/126139.bin';
const OUT = process.env.OUT_JSON || 'reverse/out_flash_result.json';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const req = (p, o = {}) =>
  uFetch(`https://${HOST}${p}`, {
    ...o,
    dispatcher: agent,
    headers: { 'content-type': 'application/json', ...(o.headers || {}) },
    signal: AbortSignal.timeout(o.t || 120000),
  });
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${stamp()}]`, ...a);

const rec = { startedAt: new Date().toISOString(), image: IMAGE };
const save = () => fs.writeFileSync(OUT, JSON.stringify(rec, null, 2));

// 建 Redfish 会话
const r = await req('/redfish/v1/SessionService/Sessions', {
  method: 'POST',
  body: JSON.stringify({ UserName: process.env.BMC_USER || 'admin', Password: process.env.BMC_PASS || '' }),
});
const token = r.headers.get('x-auth-token');
if (!token) {
  log('建会话失败:', r.status, (await r.text()).slice(0, 200));
  process.exit(1);
}
const h = { 'x-auth-token': token };
log('Redfish 会话已建立');

// 刷前记录当前版本
try {
  const d = await (await req('/redfish/v1/Managers/Self', { headers: h })).json();
  rec.before = { FirmwareVersion: d.FirmwareVersion, Model: d.Model, Status: d.Status };
  log('刷前固件版本:', d.FirmwareVersion);
} catch (e) {
  log('读固件版本异常:', e.name);
}
save();

// 预热：确认镜像 URL 本机可达（避免 BMC 拉取失败后才发现）
try {
  const head = await uFetch(IMAGE, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
  log(`镜像自检: ${IMAGE} → HTTP ${head.status}, Content-Length=${head.headers.get('content-length')}`);
  rec.imageCheck = { status: head.status, length: head.headers.get('content-length') };
} catch (e) {
  log('⚠️ 镜像 URL 本机不可达:', e.name, e.message);
  rec.imageCheck = { error: e.name + ': ' + e.message };
}
save();

// 请求体：默认只发 ActionInfo 里标为必填的两个字段。
// 实测教训：带上 UpdateComponent + ResetBMC 时，POST 会无限挂起且连任务都不建
// （AMI 侧很可能把 ResetBMC 理解成「先复位进刷写模式」，然后等一个永远不来的握手）；
// 历史上唯一一次成功建任务（202+Tasks/1+「Device is prepareing flash firmware」）用的正是最小 body。
const body = { ImageURI: IMAGE, TransferProtocol: 'HTTP' };
if (process.env.ADD_EXTRAS === '1') {
  body.UpdateComponent = process.env.UPDATE_COMPONENT || 'BMC';
  body.ResetBMC = true;
}
log('发出 SimpleUpdate:', JSON.stringify(body));
const t0 = Date.now();
let res;
try {
  // 超时给足 15 分钟：AMI 的 SimpleUpdate 可能是同步的（BMC 拉完镜像并刷完才回响应），
  // 中途掐断连接有打断刷写的风险，那才是真正会变砖的操作。
  res = await req('/redfish/v1/UpdateService/Actions/SimpleUpdate', { method: 'POST', headers: h, body: JSON.stringify(body), t: 900000 });
} catch (e) {
  log(`SimpleUpdate 请求异常（${Math.round((Date.now() - t0) / 1000)}s）:`, e.name, e.message);
  rec.post = { error: e.name + ': ' + e.message, elapsedMs: Date.now() - t0 };
  save();
  log('不退出：改为查任务列表，看 BMC 是否已在后台开始刷写。');
  try {
    const tl = await (await req('/redfish/v1/TaskService/Tasks', { headers: h, t: 25000 })).json();
    log('任务列表:', JSON.stringify((tl.Members || []).map((x) => x['@odata.id'])));
    rec.tasksAfterTimeout = (tl.Members || []).map((x) => x['@odata.id']);
  } catch (e2) {
    log('查任务列表也失败:', e2.name);
  }
  save();
  process.exit(3);
}
const text = await res.text();
log(`SimpleUpdate → ${res.status}（${Math.round((Date.now() - t0) / 1000)}s）`);
log('响应头 Location:', res.headers.get('location') || '(无)');
log('响应体:', text.slice(0, 600));
rec.post = { status: res.status, body: text.slice(0, 2000), location: res.headers.get('location'), elapsedMs: Date.now() - t0 };
save();

// 轮询任务：BMC 会在刷写完成/失败后自行重启，任务查询会先失败后失联
const taskId = (res.headers.get('location') || '').split('/').filter(Boolean).pop() || '1';
log(`开始轮询任务 ${taskId}（BMC 稍后会失联，属正常）`);
for (let i = 1; i <= 60; i++) {
  await new Promise((s) => setTimeout(s, 15000));
  try {
    const tr = await req(`/redfish/v1/TaskService/Tasks/${taskId}`, { headers: h, t: 20000 });
    if (tr.status !== 200) {
      log(`#${i} 任务查询 ${tr.status}（会话可能已随 BMC 重启失效）`);
      continue;
    }
    const d = await tr.json();
    log(`#${i} TaskState=${d.TaskState} Percent=${d.PercentComplete ?? '-'} Status=${d.TaskStatus ?? '-'}`);
    rec.lastTask = { i, TaskState: d.TaskState, PercentComplete: d.PercentComplete, TaskStatus: d.TaskStatus, Messages: d.Messages };
    save();
    if (['Completed', 'Exception', 'Cancelled', 'Killed', 'Interrupted'].includes(d.TaskState)) {
      log('任务进入终态:', d.TaskState);
      break;
    }
  } catch (e) {
    log(`#${i} 任务查询异常 ${e.name} —— BMC 很可能正在重启`);
  }
}
log('脚本结束。BMC 重启后请用 reverse/wait_bmc_recover.mjs 等它回来并核对版本。');
rec.finishedAt = new Date().toISOString();
save();
process.exit(0);
