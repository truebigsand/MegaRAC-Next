// 升级后验证：版本、配置保留情况（对照升级前快照）、以及关键接口回归。
import { Agent, fetch as uFetch } from 'undici';
import fs from 'node:fs';

const HOST = process.env.BMC_HOST || '192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const raw = (p, o = {}) => uFetch(`https://${HOST}${p}`, { ...o, dispatcher: agent, signal: AbortSignal.timeout(o.t || 40000) });
const log = (...a) => console.log(...a);

// --- 经典 web 登录（带重试）---
let login = {}, cookie = '';
for (let i = 1; i <= 20; i++) {
  try {
    const lr = await raw('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: process.env.BMC_PASS }).toString(),
    });
    const t = await lr.text();
    try { login = JSON.parse(t); } catch { login = {}; }
    if (lr.status === 200 && login.ok === 0) { cookie = (lr.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; '); break; }
    log('登录', lr.status, t.slice(0, 90));
  } catch (e) { log('登录异常', e.name); }
  await new Promise((r) => setTimeout(r, 12000));
}
if (!cookie) { log('无法登录'); process.exit(1); }
const H = { cookie, 'X-CSRFTOKEN': login.CSRFToken, 'X-Requested-With': 'XMLHttpRequest' };
log('✓ 登录成功（经典 web 通道正常）');

const get = async (p) => {
  try { const r = await raw(p, { headers: H }); const t = await r.text(); try { return { status: r.status, data: JSON.parse(t) }; } catch { return { status: r.status, data: t.slice(0, 200) }; } }
  catch (e) { return { status: 0, data: e.name }; }
};

// --- 版本 ---
const fw = await get('/api/maintenance/firmware-info');
log('\n=== 固件信息 ===');
log(JSON.stringify(fw.data).slice(0, 400));

// --- 与升级前快照对比 ---
const snap = JSON.parse(fs.readFileSync('reverse/pre_upgrade_snapshot.json', 'utf8'));
const CMP = [
  ['settings/network', '/api/settings/network'],
  ['settings/users', '/api/settings/users'],
  ['settings/fanprofile/mode', '/api/settings/fanprofile/mode'],
  ['settings/fanprofile/collection', '/api/settings/fanprofile/collection'],
  ['settings/services', '/api/settings/services'],
  ['settings/media/general', '/api/settings/media/general'],
  ['settings/date-time', '/api/settings/date-time'],
];
log('\n=== 配置保留对比（升级前 vs 升级后）===');
for (const [key, path] of CMP) {
  const before = snap[key]?.data;
  const after = (await get(path)).data;
  const bs = JSON.stringify(before);
  const as = JSON.stringify(after);
  const same = bs === as;
  log(`\n[${same ? '一致 ✓' : '有差异 ⚠'} ] ${path}`);
  if (!same) {
    log('  升级前:', bs.slice(0, 320));
    log('  升级后:', as.slice(0, 320));
  }
}

// --- 回归 ---
log('\n=== 关键接口回归 ===');
for (const [name, path] of [
  ['传感器', '/api/sensors'],
  ['电源状态', '/api/chassis-status'],
  ['SEL 日志', '/api/logs/event?LASTEVENTID=0'],
  ['会话表(真实)', '/api/settings/service-sessions'],
  ['服务列表', '/api/settings/services'],
  ['风扇模式', '/api/settings/fanprofile/mode'],
  ['KVM 授权状态', '/api/settings/media/adviser'],
]) {
  const r = await get(path);
  log(`  ${name.padEnd(14)} ${path} → ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
}

// --- Redfish 侧 ---
const rr = await raw('/redfish/v1/SessionService/Sessions', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ UserName: 'admin', Password: process.env.BMC_PASS }),
});
const tok = rr.headers.get('x-auth-token');
log(`\nRedfish 登录: ${rr.status} ${tok ? '✓' : '✗'}`);
if (tok) {
  const d = await (await raw('/redfish/v1/Managers/Self', { headers: { 'x-auth-token': tok } })).json();
  log(`  Managers/Self: ${d.FirmwareVersion} | ${d.Status?.State}/${d.Status?.Health}`);
  const u = await (await raw('/redfish/v1/UpdateService', { headers: { 'x-auth-token': tok }, t: 60000 })).json().catch((e) => ({ err: e.name }));
  log(`  UpdateService: ${JSON.stringify(u).slice(0, 200)}`);
}
process.exit(0);
