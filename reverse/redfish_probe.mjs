// Redfish 能力探测（只读）：会话登录 → 看关键资源 → 注销会话。
// 用法: BMC_PASS=... node reverse/redfish_probe.mjs
// 目的：确认这台 BMC 能通过标准 Redfish 做哪些事（虚拟介质/SOL/固件更新/事件订阅/遥测）。
import { Agent, fetch as uFetch } from 'undici';

const HOST = process.env.BMC_HOST || '192.168.0.200';
const USER = process.env.BMC_USER || 'admin';
const PASS = process.env.BMC_PASS || '';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const base = `https://${HOST}`;

const req = (path, opts = {}) =>
  uFetch(base + path, { ...opts, dispatcher: agent, headers: { 'content-type': 'application/json', ...(opts.headers || {}) }, signal: AbortSignal.timeout(25000) });

const show = async (path, pick) => {
  try {
    const r = await req(path, { headers: { 'x-auth-token': token } });
    if (r.status !== 200) return { path, status: r.status, body: (await r.text()).slice(0, 100) };
    const d = await r.json();
    const out = { path, status: 200 };
    if (pick) pick(d, out);
    return out;
  } catch (e) {
    return { path, error: e.name + ': ' + e.message };
  }
};

// 1) 建 Redfish 会话
let token = '';
try {
  const r = await req('/redfish/v1/SessionService/Sessions', {
    method: 'POST',
    body: JSON.stringify({ UserName: USER, Password: PASS }),
  });
  token = r.headers.get('x-auth-token') || '';
  console.log('Redfish 会话:', r.status, token ? '拿到 X-Auth-Token ✓' : '无 token');
  if (!token) {
    console.log('响应:', (await r.text()).slice(0, 200));
    process.exit(1);
  }
} catch (e) {
  console.log('建会话失败:', e.message);
  process.exit(1);
}

const results = [];
results.push(await show('/redfish/v1/Managers', (d, o) => {
  o.managerIds = (d.Members || []).map((m) => m['@odata.id']);
}));
results.push(await show('/redfish/v1/Systems', (d, o) => {
  o.systemIds = (d.Members || []).map((m) => m['@odata.id']);
}));

// 2) BMC 自身：固件版本 / 虚拟介质 / 网络协议（SOL、SSH、IPMI 开关）
results.push(await show('/redfish/v1/Managers/Self', (d, o) => {
  o.FirmwareVersion = d.FirmwareVersion;
  o.ManagerType = d.ManagerType;
  o.有虚拟介质 = !!d.VirtualMedia;
  o.虚拟介质链接 = d.VirtualMedia?.['@odata.id'];
  o.有串口 = !!d.SerialInterfaces;
  o.有网络协议 = !!d.NetworkProtocol;
  o.Actions = Object.keys(d.Actions || {});
}));
results.push(await show('/redfish/v1/Managers/Self/VirtualMedia', (d, o) => {
  o.介质槽 = (d.Members || []).map((m) => m['@odata.id']);
}));
results.push(await show('/redfish/v1/Managers/Self/NetworkProtocol', (d, o) => {
  o.Redfish = d.Redfish?.ProtocolEnabled;
  o.SSH = d.SSH?.ProtocolEnabled;
  o.IPMI = d.IPMI?.ProtocolEnabled;
  o.SNMP = d.SNMP?.ProtocolEnabled;
  o.KVMIP = d.KVMIP?.ProtocolEnabled;
  o.端口 = { Redfish: d.Redfish?.Port, SSH: d.SSH?.Port, IPMI: d.IPMI?.Port };
}));

// 3) 主机侧：启动项 / 电源 / 清单规模
results.push(await show('/redfish/v1/Systems/Self', (d, o) => {
  o.PowerState = d.PowerState;
  o.BootProgress = d.BootProgress?.BootState;
  o.有一次性启动 = !!d.Boot;
  o.内存GiB = d.Memory?.TotalSystemMemoryGiB ?? d.MemorySummary?.TotalSystemMemoryGiB;
  o.型号 = d.Model;
  o.可改启动顺序 = !!d.Actions?.BootOptions || undefined;
}));

// 4) 固件更新能力
results.push(await show('/redfish/v1/UpdateService', (d, o) => {
  o.支持SimpleUpdate = !!(d.Actions?.['#UpdateService.SimpleUpdate']);
  o.推送URI方式 = Object.keys(d.Actions || {});
  o.HttpPushUri = d.HttpPushUri;
  o.FirmwareInventory = d.FirmwareInventory?.['@odata.id'];
}));

// 5) 事件订阅 / 遥测
results.push(await show('/redfish/v1/EventService', (d, o) => {
  o.支持订阅 = !!d.Subscriptions;
  o.EventTypesForSubscription = d.EventTypesForSubscription;
  o.可改订阅 = !!d.Actions;
}));
results.push(await show('/redfish/v1/TelemetryService', (d, o) => {
  o.支持指标报告 = !!d.MetricReports;
  o.支持指标定义 = !!d.MetricDefinitions;
}));

// 6) 账户服务（用户/密码策略）
results.push(await show('/redfish/v1/AccountService', (d, o) => {
  o.账户数 = d.Accounts?.['@odata.count'];
  o.密码最小长度 = d.MinPasswordLength;
  o.锁定策略 = d.AccountLockoutThreshold;
}));

for (const r of results) console.log(JSON.stringify(r));

// 7) 注销会话（避免占用 BMC 会话表）
try {
  const r = await req('/redfish/v1/SessionService/Sessions', { headers: { 'x-auth-token': token } });
  if (r.status === 200) {
    const d = await r.json();
    const mine = (d.Members || []).find((m) => m['@odata.id']?.includes(''));
    if (mine) {
      const del = await req(mine['@odata.id'], { method: 'DELETE', headers: { 'x-auth-token': token } });
      console.log('注销本次 Redfish 会话:', del.status);
    }
  }
} catch (e) {
  console.log('注销会话失败:', e.message);
}
process.exit(0);
