// Redfish 全能力探测（只读）：逐个资源取数据并打印实际结构，
// 目的是判断「新 UI 能否完全建在 Redfish 上」，以及哪些数据必须回退到经典 web API。
// 关注点：仪表盘(系统/电源/内存/CPU)、传感器(温度/风扇)、SEL、用户、网络、日志、虚拟介质、更新服务。
import { Agent, fetch as uFetch } from 'undici';

const HOST = process.env.BMC_HOST || '192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const raw = (p, o = {}) => uFetch(`https://${HOST}${p}`, { ...o, dispatcher: agent, signal: AbortSignal.timeout(o.t || 40000) });

const r = await raw('/redfish/v1/SessionService/Sessions', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ UserName: 'admin', Password: process.env.BMC_PASS }),
});
const tok = r.headers.get('x-auth-token');
if (!tok) { console.log('登录失败', r.status); process.exit(1); }
const H = { 'x-auth-token': tok };
console.log('✓ Redfish 已登录\n');

// ⚠️ 必须限速：这台 BMC 的新固件有防滥用保护，密集请求（几十次/分钟）会触发
// HTTP 层封禁（连登录都 403），实测约 3 分钟后自愈。所以这里每个请求之间睡 1.2 秒。
let reqCount = 0;
const get = async (p, t = 40000) => {
  if (reqCount++ > 0) await new Promise((s) => setTimeout(s, 1200));
  try { const x = await raw(p, { headers: H, t }); const txt = await x.text(); return { status: x.status, data: txt.startsWith('{') || txt.startsWith('[') ? JSON.parse(txt) : txt.slice(0, 150) }; }
  catch (e) { return { status: 0, data: e.name }; }
};
const brief = (o, keys) => keys.map((k) => `${k}=${JSON.stringify(o?.[k])?.slice(0, 60)}`).join(' ');

// ---- 1) 服务根：看有哪些集合 ----
const root = await get('/redfish/v1/');
console.log('=== 服务根集合 ===');
for (const [k, v] of Object.entries(root.data)) if (v?.['@odata.id']) console.log(' ', k.padEnd(26), v['@odata.id']);

// ---- 2) Systems：仪表盘要用的 ----
const sys = await get('/redfish/v1/Systems');
console.log('\n=== Systems ===');
for (const m of sys.data.Members || []) {
  const s = await get(m['@odata.id']);
  const d = s.data;
  console.log(`  ${m['@odata.id']} → ${s.status}`);
  console.log('   ', brief(d, ['PowerState', 'BiosVersion', 'Model', 'Manufacturer', 'SerialNumber', 'HostName', 'Status']));
  console.log('    Memory:', d.Memory?.Summary || '(无 Summary)', '| Processors:', (d.Processors?.Members || []).length, '个');
  console.log('    子资源:', Object.entries(d).filter(([, v]) => v?.['@odata.id']).map(([k, v]) => k + '→' + v['@odata.id']).slice(0, 14).join(' '));
}

// ---- 3) Chassis / Thermal：传感器页的关键 ----
const ch = await get('/redfish/v1/Chassis');
console.log('\n=== Chassis（传感器来源）===');
for (const m of ch.data.Members || []) {
  const c = await get(m['@odata.id']);
  console.log(`  ${m['@odata.id']} → ${c.status} `, brief(c.data, ['ChassisType', 'Model', 'SerialNumber']));
  const th = await get(m['@odata.id'] + '/Thermal');
  if (th.status === 200) {
    console.log('     Thermal: 温度', (th.data.Temperatures || []).length, '个 / 风扇', (th.data.Fans || []).length, '个');
    for (const t of (th.data.Temperatures || []).slice(0, 3)) console.log('       T:', brief(t, ['Name', 'ReadingCelsius', 'UpperCritical', 'Status']));
    for (const f of (th.data.Fans || []).slice(0, 3)) console.log('       F:', brief(f, ['Name', 'Reading', 'ReadingUnits', 'Status']));
  } else console.log('     Thermal →', th.status, th.data);
  const pw = await get(m['@odata.id'] + '/Power');
  if (pw.status === 200) {
    console.log('     Power: 电压', (pw.data.Voltages || []).length, '个 / 功耗', JSON.stringify(pw.data.PowerControl || []).slice(0, 140));
  } else console.log('     Power →', pw.status);
}

// ---- 4) Managers：网络/日志 ----
const mgr = await get('/redfish/v1/Managers/Self', 60000);
console.log('\n=== Managers/Self ===');
console.log(' ', brief(mgr.data, ['FirmwareVersion', 'Model', 'PowerState', 'DateTime', 'Status']));
console.log('  Actions:', Object.keys(mgr.data.Actions || {}).join(', '));
const eth = await get('/redfish/v1/Managers/Self/EthernetInterfaces');
console.log('  EthernetInterfaces:', eth.status, JSON.stringify(eth.data).slice(0, 160));
const ls = await get('/redfish/v1/Managers/Self/LogServices');
if (ls.status === 200) {
  console.log('  LogServices:', (ls.data.Members || []).map((x) => x['@odata.id']).join(' '));
  for (const m of (ls.data.Members || []).slice(0, 2)) {
    const e = await get(m['@odata.id'] + '/Entries?$top=3', 50000);
    console.log(`    ${m['@odata.id']}: ${e.status}`, JSON.stringify((e.data.Members || []).slice(0, 1)).slice(0, 220));
  }
}
const vm = await get('/redfish/v1/Managers/Self/VirtualMedia');
console.log('  VirtualMedia:', vm.status, (vm.data.Members || []).map((x) => x['@odata.id']).join(' '));

// ---- 5) 账户 / 会話 ----
const acc = await get('/redfish/v1/AccountService/Accounts');
console.log('\n=== AccountService ===');
console.log('  Accounts:', acc.status, (acc.data.Members || []).map((x) => x['@odata.id']).join(' '));
for (const m of (acc.data.Members || []).slice(0, 3)) {
  const a = await get(m['@odata.id']);
  console.log('   ', brief(a.data, ['UserName', 'RoleId', 'Enabled']), (a.data.Oem ? '有 Oem' : ''));
}

// ---- 6) 更新服务 / 固件清单 ----
const inv = await get('/redfish/v1/UpdateService/FirmwareInventory');
console.log('\n=== UpdateService ===');
console.log('  FirmwareInventory:', inv.status);
for (const m of inv.data.Members || []) {
  const s = await get(m['@odata.id']);
  console.log(`    ${m['@odata.id'].split('/').pop()}: ${s.status}`, brief(s.data, ['Version', 'Updateable', 'Name', 'Status']));
}
const su = await get('/redfish/v1/UpdateService/SimpleUpdateActionInfo');
console.log('  SimpleUpdateActionInfo:', su.status, JSON.stringify(su.data).slice(0, 200));

// ---- 7) 事件订阅 / 遥测（看能否替代轮询） ----
console.log('\n=== 事件与遥测 ===');
const es = await get('/redfish/v1/EventService');
console.log('  EventService:', es.status, brief(es.data, ['ServiceEnabled', 'DeliveryRetryAttempts']), '子:', Object.entries(es.data).filter(([, v]) => v?.['@odata.id']).map(([k]) => k).join(',') || JSON.stringify(Object.keys(es.data)).slice(0, 200));
const st = await get('/redfish/v1/EventService/Subscriptions');
console.log('  Subscriptions:', st.status, JSON.stringify(st.data).slice(0, 200));
const ts = await get('/redfish/v1/TelemetryService');
console.log('  TelemetryService:', ts.status, brief(ts.data, ['ServiceEnabled', 'MinCollectionInterval']));
const mr = await get('/redfish/v1/TelemetryService/MetricReports');
console.log('  MetricReports:', mr.status, (mr.data.Members || []).map((x) => x['@odata.id']).join(' '));

// ---- 8) 会话 ----
const sess = await get('/redfish/v1/SessionService/Sessions');
console.log('\n=== 会话 ===');
console.log('  当前:', sess.status, (sess.data.Members || []).length, '个', JSON.stringify(sess.data.Members || []).slice(0, 200));
await raw(`/redfish/v1/SessionService/Sessions/${tok}`, { method: 'DELETE', headers: H }).catch(() => {});
process.exit(0);
