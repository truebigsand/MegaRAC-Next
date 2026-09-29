// 通过 Redfish UpdateService.SimpleUpdate 升级 BMC 固件。
// 参数规格来自 BMC 自己宣告的 SimpleUpdateActionInfo：
//   ImageURI(必填) / TransferProtocol(必填, 允许 HTTP|FTP) / UpdateComponent(可选, BMC|BIOS|MB_CPLD|BPB_CPLD)
// 刷写期间 BMC 会重启，主机与虚拟机不受影响。
import { Agent, fetch as uFetch } from 'undici';

const HOST = process.env.BMC_HOST || '192.168.0.200';
const IMAGE = process.env.IMG_URL || 'http://192.168.0.101:8899/126139.bin';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const req = (p, o = {}) =>
  uFetch(`https://${HOST}${p}`, {
    ...o,
    dispatcher: agent,
    headers: { 'content-type': 'application/json', ...(o.headers || {}) },
    signal: AbortSignal.timeout(120000),
  });

const r = await req('/redfish/v1/SessionService/Sessions', {
  method: 'POST',
  body: JSON.stringify({ UserName: process.env.BMC_USER || 'admin', Password: process.env.BMC_PASS || '' }),
});
const token = r.headers.get('x-auth-token');
if (!token) {
  console.log('建会话失败:', r.status, (await r.text()).slice(0, 200));
  process.exit(1);
}
const h = { 'x-auth-token': token };
console.log('Redfish 会话已建立');

// BMC 宣告的 target 是 /redfish/v1/UpdateService/Actions/SimpleUpdate（AMI 用短形式）
const SIMPLE_UPDATE_TARGET = '/redfish/v1/UpdateService/Actions/SimpleUpdate';

const body = {
  ImageURI: IMAGE,
  TransferProtocol: 'HTTP',
  UpdateComponent: 'BMC',
  // 默认会让 BMC 自己重启完成升级；这里保持默认（不显式关闭）
};
console.log('发出 SimpleUpdate:', JSON.stringify(body));
const t0 = Date.now();
let res;
try {
  res = await req(SIMPLE_UPDATE_TARGET, {
    method: 'POST',
    headers: h,
    body: JSON.stringify(body),
  });
} catch (e) {
  console.log(`SimpleUpdate 请求异常（${Math.round((Date.now() - t0) / 1000)}s）:`, e.name, e.message);
  process.exit(2);
}
const text = await res.text();
console.log(`SimpleUpdate → ${res.status}（${Math.round((Date.now() - t0) / 1000)}s）`);
console.log('响应:', text.slice(0, 600));
if (res.headers.get('location')) console.log('Location:', res.headers.get('location'));

// 看任务/进度（AMI 通常返回 202 + 一个 Task 或 200 直接开始）
try {
  const tasks = await req('/redfish/v1/TaskService/Tasks', { headers: h });
  if (tasks.status === 200) {
    const d = await tasks.json();
    console.log('TaskService 任务:', JSON.stringify((d.Members || []).map((m) => m['@odata.id'])));
  }
} catch (e) {
  console.log('查任务失败:', e.name);
}

try {
  const inv = await (await req('/redfish/v1/UpdateService/FirmwareInventory', { headers: h })).json();
  console.log('FirmwareInventory:', JSON.stringify((inv.Members || []).map((m) => m['@odata.id'])));
} catch (e) {
  console.log('查固件清单失败:', e.name);
}
console.log('\nBMC 即将重启，接下来用外部轮询等它回来。');
process.exit(0);
