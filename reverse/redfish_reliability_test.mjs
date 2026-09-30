// 决定性测量：这台 BMC 的 Redfish 在「规范使用」下到底可靠吗？
// 规范 = 单会话 + 每请求间隔 3 秒 + 超时 120 秒（绝不 abort）+ 失败即重登 + 每次打印耗时。
// 结果决定架构：若关键资源稳定 200，则以 Redfish 为主数据层；否则退回经典 web API 为主。
import { Agent, fetch as uFetch } from 'undici';
import fs from 'node:fs';

const HOST = process.env.BMC_HOST || '192.168.0.200';
const PAS = process.env.BMC_PASS || '';
const LOGF = 'reverse/out_reliability.log';
try { fs.unlinkSync(LOGF); } catch {}
const say = (s) => { fs.appendFileSync(LOGF, s + '\n'); console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const agent = new Agent({ connect: { rejectUnauthorized: false } });
const raw = (p, o = {}) => uFetch(`https://${HOST}${p}`, { ...o, dispatcher: agent, signal: AbortSignal.timeout(o.t || 120000) });

let tok = '';
let relogins = 0;
const login = async () => {
  const r = await raw('/redfish/v1/SessionService/Sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ UserName: 'admin', Password: PAS }), t: 60000,
  });
  tok = r.headers.get('x-auth-token') || '';
  return tok;
};
await login();
say(`登录 ${tok ? '✓' : '✗'}`);
if (!tok) process.exit(1);

// 新 UI 真正需要的资源清单
const TARGETS = [
  ['Manager 自身', '/redfish/v1/Managers/Self'],
  ['Systems 集合', '/redfish/v1/Systems'],
  ['Chassis 集合', '/redfish/v1/Chassis'],
  ['UpdateService', '/redfish/v1/UpdateService'],
  ['固件清单', '/redfish/v1/UpdateService/FirmwareInventory'],
  ['账户集合', '/redfish/v1/AccountService/Accounts'],
  ['EventService', '/redfish/v1/EventService'],
  ['Telemetry', '/redfish/v1/TelemetryService'],
  ['会话集合', '/redfish/v1/SessionService/Sessions'],
  ['以太网口', '/redfish/v1/Managers/Self/EthernetInterfaces'],
  ['日志服务', '/redfish/v1/Managers/Self/LogServices'],
  ['虚拟介质', '/redfish/v1/Managers/Self/VirtualMedia'],
];

const hit = async (label, p) => {
  const t0 = Date.now();
  try {
    const r = await raw(p, { headers: { 'x-auth-token': tok } });
    const txt = await r.text();
    const j = txt.startsWith('{') || txt.startsWith('[') ? JSON.parse(txt) : null;
    const extra = j ? (j.FirmwareVersion || j.Name || (j.Members ? 'Members=' + j.Members.length : '')) : txt.replace(/\s+/g, ' ').slice(0, 60);
    say(`  ${label.padEnd(12)} ${String(r.status).padEnd(4)} ${String(Date.now() - t0).padStart(6)}ms  ${extra}`);
    if (r.status === 401 || r.status === 403) { relogins++; await login(); }
    return r.status;
  } catch (e) {
    say(`  ${label.padEnd(12)} ${e.name.padEnd(4)} ${String(Date.now() - t0).padStart(6)}ms  （失败，重登后继续）`);
    relogins++;
    await login();
    return 0;
  }
};

say('\n--- 第一轮 ---');
let ok1 = 0;
for (const [label, p] of TARGETS) {
  if (await hit(label, p) === 200) ok1++;
  await sleep(3000);
}

say('\n--- 第二轮（同样清单，看是否稳定）---');
let ok2 = 0;
for (const [label, p] of TARGETS) {
  if (await hit(label, p) === 200) ok2++;
  await sleep(3000);
}

// 展开关键资源的成员（新 UI 要用的细节）
say('\n--- 展开 Systems/Chassis 成员 ---');
const expand = async (collPath) => {
  try {
    const r = await raw(collPath, { headers: { 'x-auth-token': tok } });
    if (r.status !== 200) { say(`  ${collPath} → ${r.status}`); return null; }
    const j = await r.json();
    say(`  ${collPath} 成员: ${JSON.stringify((j.Members || []).map((m) => m['@odata.id']))}`);
    return j;
  } catch (e) { say(`  ${collPath} → ${e.name}`); return null; }
};
const sysC = await expand('/redfish/v1/Systems');
await sleep(3000);
if (sysC?.Members?.[0]) {
  const id = sysC.Members[0]['@odata.id'];
  say(`  取 ${id}`);
  const t0 = Date.now();
  try {
    const r = await raw(id, { headers: { 'x-auth-token': tok } });
    const d = await r.json();
    say(`    → ${r.status} (${Date.now() - t0}ms) ${JSON.stringify({ PowerState: d.PowerState, BiosVersion: d.BiosVersion, Model: d.Model, Serial: d.SerialNumber, Memory: d.Memory?.Summary, Status: d.Status })}`);
  } catch (e) { say(`    → ${e.name} (${Date.now() - t0}ms)`); }
}
await sleep(3000);
const chC = await expand('/redfish/v1/Chassis');
await sleep(3000);
if (chC?.Members?.[0]) {
  const id = chC.Members[0]['@odata.id'];
  for (const sub of ['', '/Thermal', '/Power']) {
    const t0 = Date.now();
    try {
      const r = await raw(id + sub, { headers: { 'x-auth-token': tok } });
      const d = await r.json();
      const info = sub === '' ? `${d.ChassisType} ${d.Model}` : sub === '/Thermal' ? `温度=${(d.Temperatures || []).length} 风扇=${(d.Fans || []).length}` : `电压=${(d.Voltages || []).length} 功耗=${JSON.stringify(d.PowerControl?.[0] || {})}`;
      say(`    ${(id + sub).replace('/redfish/v1', '')} → ${r.status} (${Date.now() - t0}ms) ${info}`);
    } catch (e) { say(`    ${(id + sub)} → ${e.name} (${Date.now() - t0}ms)`); }
    await sleep(3000);
  }
}

say(`\n结论数据：第一轮 ${ok1}/${TARGETS.length} 成功，第二轮 ${ok2}/${TARGETS.length} 成功，重登 ${relogins} 次`);
await raw(`/redfish/v1/SessionService/Sessions/${tok}`, { method: 'DELETE', headers: { 'x-auth-token': tok } }).catch(() => {});
process.exit(0);
