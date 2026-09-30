// 把新 UI 需要的数据逐项映射到 Redfish，并打印真实字段（用于建类型与归一化）。
// 纪律：单会话、每个请求间隔 1.5 秒、超时给 120 秒（绝不 abort —— 实测 abort 会毒死会话）。
import { Agent, fetch as uFetch } from 'undici';
import fs from 'node:fs';

const LOGF = 'reverse/out_mapping_progress.log';
try { fs.unlinkSync(LOGF); } catch {}
// 写文件日志而不是只靠 stdout：stdout 重定向到文件时会缓冲，看不到实时进度
const say = (s) => { fs.appendFileSync(LOGF, s + '\n'); console.log(s); };

const HOST = process.env.BMC_HOST || '192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const raw = (p, o = {}) => uFetch(`https://${HOST}${p}`, { ...o, dispatcher: agent, signal: AbortSignal.timeout(o.t || 120000) });

const login = async () => {
  const r = await raw('/redfish/v1/SessionService/Sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ UserName: 'admin', Password: process.env.BMC_PASS }), t: 40000,
  });
  return r.headers.get('x-auth-token');
};
let tok = await login();
if (!tok) { say('登录失败'); process.exit(1); }
const H = { 'x-auth-token': tok };
say('✓ 已登录\n');

let n = 0;
const get = async (p) => {
  if (n++) await new Promise((s) => setTimeout(s, 1500));
  try { const r = await raw(p, { headers: H }); const txt = await r.text(); return { status: r.status, data: txt.startsWith('{') || txt.startsWith('[') ? JSON.parse(txt) : txt.slice(0, 120) }; }
  catch (e) { return { status: 0, data: e.name }; }
};

const dump = {};   // 收集关键结构，便于随后建类型
const P = (label, v) => say(`  ${label}: ${JSON.stringify(v)}`);

// ---- 仪表盘 ----
say('=== 1) 仪表盘 ===');
const mgr = await get('/redfish/v1/Managers/Self');
say(`Managers/Self → ${mgr.status}`);
if (mgr.status === 200) {
  P('FirmwareVersion', mgr.data.FirmwareVersion);
  P('Model/UUID', [mgr.data.Model, mgr.data.UUID]);
  P('DateTime', [mgr.data.DateTime, mgr.data.DateTimeLocalOffset]);
  P('PowerState', mgr.data.PowerState);
}
const sysC = await get('/redfish/v1/Systems');
say(`Systems 集合 → ${sysC.status}`, JSON.stringify(sysC.data.Members || sysC.data).slice(0, 200));
for (const m of sysC.data.Members || []) {
  const s = await get(m['@odata.id']);
  say(`  ${m['@odata.id']} → ${s.status}`);
  if (s.status === 200) {
    dump.System = s.data;
    P('PowerState/Model/Serial', [s.data.PowerState, s.data.Model, s.data.SerialNumber]);
    P('BiosVersion', s.data.BiosVersion);
    P('Memory.Summary', s.data.Memory?.Summary);
    P('ProcessorSummary', s.data.ProcessorSummary || s.data.Processors);
    P('Status', s.data.Status);
    P('Actions', Object.keys(s.data.Actions || {}));
    P('子资源', Object.entries(s.data).filter(([, v]) => v?.['@odata.id']).map(([k, v]) => k + '→' + v['@odata.id']));
  }
}

// ---- 传感器：Thermal ----
say('\n=== 2) 传感器（Chassis/Thermal + Power）===');
const chC = await get('/redfish/v1/Chassis');
say(`Chassis 集合 → ${chC.status}`, JSON.stringify(chC.data.Members || chC.data).slice(0, 160));
for (const m of chC.data.Members || []) {
  const c = await get(m['@odata.id']);
  say(`  ${m['@odata.id']} → ${c.status}`, JSON.stringify(c.data.ChassisType || '').slice(0, 40));
  const th = await get(m['@odata.id'] + '/Thermal');
  say(`    Thermal → ${th.status}`);
  if (th.status === 200) {
    dump.Thermal = th.data;
    say(`    温度 ${(th.data.Temperatures || []).length} 个 / 风扇 ${(th.data.Fans || []).length} 个`);
    say('    温度样例:', JSON.stringify((th.data.Temperatures || [])[0]));
    say('    风扇样例:', JSON.stringify((th.data.Fans || [])[0]));
  }
  const pw = await get(m['@odata.id'] + '/Power');
  say(`    Power → ${pw.status}`);
  if (pw.status === 200) {
    dump.Power = pw.data;
    say('    电压样例:', JSON.stringify((pw.data.Voltages || [])[0] || {}));
    say('    PowerControl:', JSON.stringify(pw.data.PowerControl || []).slice(0, 220));
  }
}

// ---- 日志：SEL ----
say('\n=== 3) 日志 ===');
const sysId = (sysC.data.Members || [])[0]?.['@odata.id'] || '/redfish/v1/Systems/Self';
const sls = await get(sysId + '/LogServices');
say(`Systems LogServices → ${sls.status}`, JSON.stringify(sls.data.Members || sls.data).slice(0, 200));
for (const m of sls.data.Members || []) {
  const e = await get(m['@odata.id'] + '/Entries?$top=2');
  say(`  ${m['@odata.id']} → ${e.status} 条目=${e.data.Members?.length ?? '?'} 总数=${e.data['Members@odata.count'] ?? '?'}`);
  if (e.data.Members?.[0]) { dump.SelEntry = e.data.Members[0]; say('   样例:', JSON.stringify(e.data.Members[0]).slice(0, 300)); }
}
const mls = await get('/redfish/v1/Managers/Self/LogServices');
say(`Managers LogServices → ${mls.status}`, (mls.data.Members || []).map((x) => x['@odata.id']).join(' '));

// ---- 用户 ----
say('\n=== 4) 用户 ===');
const ac = await get('/redfish/v1/AccountService');
say(`AccountService → ${ac.status}`);
if (ac.status === 200) {
  dump.AccountService = ac.data;
  P('Lockout 相关', { Threshold: ac.data.AccountLockoutThreshold, Duration: ac.data.AccountLockoutDuration, ResetAfter: ac.data.AccountLockoutCounterResetAfter, Enabled: ac.data.AccountLockoutDuration !== undefined });
  P('Roles', JSON.stringify(ac.data.Roles || {}).slice(0, 120));
}
const accs = await get('/redfish/v1/AccountService/Accounts');
say(`Accounts → ${accs.status}`);
for (const m of (accs.data.Members || []).slice(0, 4)) {
  const a = await get(m['@odata.id']);
  say(`  ${m['@odata.id']} → ${a.status}`, JSON.stringify({ UserName: a.data.UserName, RoleId: a.data.RoleId, Enabled: a.data.Enabled, Locked: a.data.Locked }).slice(0, 160));
  if (!dump.Account) dump.Account = a.data;
}

// ---- 网络 ----
say('\n=== 5) 网络 ===');
const eth = await get('/redfish/v1/Managers/Self/EthernetInterfaces');
say(`EthernetInterfaces → ${eth.status}`);
for (const m of (eth.data.Members || []).slice(0, 2)) {
  const e = await get(m['@odata.id']);
  say(`  ${m['@odata.id']} → ${e.status}`);
  if (e.status === 200) { dump.Ethernet = e.data; P('字段', Object.keys(e.data).slice(0, 22)); P('IPv4', e.data.IPv4Addresses); P('DHCP', e.data.DHCPv4); }
}

// ---- 更新服务 / 固件清单 ----
say('\n=== 6) 更新服务 ===');
const inv = await get('/redfish/v1/UpdateService/FirmwareInventory');
say(`FirmwareInventory → ${inv.status}`);
for (const m of inv.data.Members || []) {
  const s = await get(m['@odata.id']);
  say(`  ${m['@odata.id'].split('/').pop()} → ${s.status}`, JSON.stringify({ Version: s.data.Version, Updateable: s.data.Updateable, Name: s.data.Name })); 
}

// ---- 虚拟介质 ----
say('\n=== 7) 虚拟介质 ===');
const vm = await get('/redfish/v1/Managers/Self/VirtualMedia');
say(`VirtualMedia → ${vm.status}`, JSON.stringify(vm.data.Members || vm.data).slice(0, 160));
for (const m of (vm.data.Members || []).slice(0, 2)) {
  const v = await get(m['@odata.id']);
  say(`  ${m['@odata.id']} → ${v.status}`, JSON.stringify({ Inserted: v.data.Inserted, Image: v.data.Image, MediaTypes: v.data.MediaTypes, Actions: Object.keys(v.data.Actions || {}) }));
}

// ---- 事件/遥测（能否替代轮询）----
say('\n=== 8) 事件订阅与遥测 ===');
const es = await get('/redfish/v1/EventService');
say(`EventService → ${es.status}`, JSON.stringify({ ServiceEnabled: es.data.ServiceEnabled, 子: Object.entries(es.data).filter(([, v]) => v?.['@odata.id']).map(([k]) => k) }));
const subs = await get('/redfish/v1/EventService/Subscriptions');
say(`Subscriptions → ${subs.status}`, JSON.stringify(subs.data.Members || subs.data).slice(0, 200));
const ts = await get('/redfish/v1/TelemetryService');
say(`TelemetryService → ${ts.status}`, JSON.stringify({ ServiceEnabled: ts.data.ServiceEnabled, MinInterval: ts.data.MinCollectionInterval, MetricReports: ts.data.MetricReports?.['@odata.id'] }));
const mr = await get('/redfish/v1/TelemetryService/MetricReports');
say(`MetricReports → ${mr.status}`, JSON.stringify(mr.data.Members || mr.data).slice(0, 300));

fs.writeFileSync('reverse/out_redfish_shapes.json', JSON.stringify(dump, null, 1));
say('\n关键结构已存 reverse/out_redfish_shapes.json（键:', Object.keys(dump).join(', '), '）');
await raw(`/redfish/v1/SessionService/Sessions/${tok}`, { method: 'DELETE', headers: H }).catch(() => {});
process.exit(0);
