// 升级前预检：BMC 健康状态、更新服务、任务队列、是否卡在「更新中」。
// 用法: BMC_PASS=... node reverse/upgrade_precheck.mjs
import { Agent, fetch as uFetch } from 'undici';

const HOST = process.env.BMC_HOST || '192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const req = (p, o = {}) =>
  uFetch(`https://${HOST}${p}`, {
    ...o,
    dispatcher: agent,
    headers: { 'content-type': 'application/json', ...(o.headers || {}) },
    signal: AbortSignal.timeout(20000),
  });

const r = await req('/redfish/v1/SessionService/Sessions', {
  method: 'POST',
  body: JSON.stringify({ UserName: process.env.BMC_USER || 'admin', Password: process.env.BMC_PASS || '' }),
});
const token = r.headers.get('x-auth-token');
console.log('Redfish 会话:', r.status, token ? 'OK ✓' : 'FAIL ✗');
if (!token) {
  console.log((await r.text()).slice(0, 300));
  process.exit(1);
}
const h = { 'x-auth-token': token };

const get = async (p) => {
  try {
    const rr = await req(p, { headers: h });
    const t = await rr.text();
    return { status: rr.status, text: t };
  } catch (e) {
    return { status: 0, text: `${e.name}: ${e.message}` };
  }
};

const m = await get('/redfish/v1/Managers/Self');
if (m.status === 200) {
  const d = JSON.parse(m.text);
  console.log(`Manager: 固件 ${d.FirmwareVersion} | 机型 ${d.Model} | 状态 ${d.Status?.State}/${d.Status?.Health}`);
} else console.log('Managers/Self →', m.status, m.text.slice(0, 200));

const u = await get('/redfish/v1/UpdateService');
if (u.status === 200) {
  const d = JSON.parse(u.text);
  console.log(`UpdateService: 启用=${d.ServiceEnabled} 状态=${d.Status?.State}/${d.Status?.Health}`);
  console.log('  Actions:', Object.keys(d.Actions || {}).join(', ') || '(无)');
} else console.log('UpdateService →', u.status, u.text.slice(0, 200));

const inv = await get('/redfish/v1/UpdateService/FirmwareInventory');
if (inv.status === 200) {
  const d = JSON.parse(inv.text);
  console.log('FirmwareInventory:', (d.Members || []).map((x) => x['@odata.id']).join(', ') || '(空)');
} else console.log('FirmwareInventory →', inv.status, inv.text.slice(0, 200));

const tasks = await get('/redfish/v1/TaskService/Tasks');
if (tasks.status === 200) {
  const d = JSON.parse(tasks.text);
  console.log('未完成任务:', (d.Members || []).length, JSON.stringify((d.Members || []).map((x) => x['@odata.id'])));
} else console.log('TaskService →', tasks.status, tasks.text.slice(0, 200));

// 经典 web 侧：是否卡在「固件更新进行中」/ 当前版本
const login = await req('/api/session', {
  method: 'POST',
  body: JSON.stringify({ username: process.env.BMC_USER || 'admin', password: process.env.BMC_PASS || '' }),
});
const cookie = login.headers.getSetCookie?.().map((c) => c.split(';')[0]).join('; ') || '';
console.log('经典 web 会话:', login.status, cookie ? 'OK ✓' : 'FAIL ✗');
if (cookie) {
  const fw = await req('/api/maintenance/firmware', { headers: { cookie } }).catch((e) => ({ status: 0, text: async () => e.message }));
  const t = typeof fw.text === 'function' ? await fw.text() : fw.text;
  console.log('maintenance/firmware →', fw.status, String(t).slice(0, 300));
  await req('/api/session', { method: 'DELETE', headers: { cookie } }).catch(() => {});
}

await req('/redfish/v1/SessionService/Sessions/' + token, { method: 'DELETE', headers: h }).catch(() => {});
console.log('\n预检完毕，Redfish 会话已注销');
