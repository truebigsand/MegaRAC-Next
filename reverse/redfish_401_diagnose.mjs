// 精确定位 Redfish 401 "the service was denied access" 的触发条件。
// 已知：限速无关（限速触发的是 403 且登录也失败）；root 常 200，随后大量 401。
// 本实验：单会话、少量关键请求、超时给到 60s、间隔 2s，并在结尾盘点/清理会话。
import { Agent, fetch as uFetch } from 'undici';

const HOST = process.env.BMC_HOST || '192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const raw = (p, o = {}) => uFetch(`https://${HOST}${p}`, { ...o, dispatcher: agent, signal: AbortSignal.timeout(o.t || 60000) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const login = async () => {
  const r = await raw('/redfish/v1/SessionService/Sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ UserName: 'admin', Password: process.env.BMC_PASS }), t: 30000,
  });
  const t = r.headers.get('x-auth-token');
  let body = '';
  if (!t) body = (await r.text()).slice(0, 120).replace(/\s+/g, ' ');
  return { tok: t, status: r.status, body };
};

let { tok, status, body } = await login();
console.log(`登录 → ${status} ${tok ? '✓' : '✗ ' + body}`);
if (!tok) process.exit(1);
let H = { 'x-auth-token': tok };

const hit = async (label, p) => {
  const t0 = Date.now();
  try {
    const r = await raw(p, { headers: H });
    const txt = await r.text();
    const isJson = txt.startsWith('{') || txt.startsWith('[');
    const j = isJson ? JSON.parse(txt) : null;
    const extra = j ? (j.FirmwareVersion || j.Name || (j.Members ? 'Members=' + j.Members.length : '') || Object.keys(j).slice(0, 5).join(',')) : txt.replace(/\s+/g, ' ').slice(0, 90);
    console.log(`  ${label.padEnd(26)} → ${r.status} (${Date.now() - t0}ms) ${extra}`);
    return r.status;
  } catch (e) {
    console.log(`  ${label.padEnd(26)} → ${e.name} (${Date.now() - t0}ms)`);
    return 0;
  }
};

console.log('\n--- 关键资源逐个取（间隔 2s，超时 60s）---');
await hit('service root', '/redfish/v1/');
await sleep(2000);
const codes = [];
codes.push(await hit('Managers/Self', '/redfish/v1/Managers/Self'));
await sleep(2000);
codes.push(await hit('Chassis 集合', '/redfish/v1/Chassis'));
await sleep(2000);
codes.push(await hit('Systems 集合', '/redfish/v1/Systems'));
await sleep(2000);
codes.push(await hit('UpdateService', '/redfish/v1/UpdateService'));
await sleep(2000);
codes.push(await hit('FirmwareInventory', '/redfish/v1/UpdateService/FirmwareInventory'));
await sleep(2000);
codes.push(await hit('Accounts', '/redfish/v1/AccountService/Accounts'));
await sleep(2000);
codes.push(await hit('会话列表', '/redfish/v1/SessionService/Sessions'));

console.log('\n--- 若会话列表能取到，清理非当前会话 ---');
try {
  const r = await raw('/redfish/v1/SessionService/Sessions', { headers: H });
  if (r.status === 200) {
    const j = await r.json();
    const mine = `/redfish/v1/SessionService/Sessions/${tok}`;
    console.log('  当前会话数:', (j.Members || []).length);
    for (const m of j.Members || []) {
      const id = m['@odata.id'];
      if (id === mine) { console.log('    (跳过自己)', id); continue; }
      const d = await raw(id, { method: 'DELETE', headers: H }).catch(() => ({ status: 0 }));
      console.log('    DELETE', id, '→', d.status);
      await sleep(500);
    }
  } else console.log('  会话列表 →', r.status, '（被拒，无法清理）');
} catch (e) { console.log('  清理异常', e.name); }

// 清理后再试一次（看清理是否有帮助）
await sleep(1500);
console.log('\n--- 清理后再取一次 Systems ---');
await hit('Systems 集合(重试)', '/redfish/v1/Systems');
await raw(`/redfish/v1/SessionService/Sessions/${tok}`, { method: 'DELETE', headers: H }).catch(() => {});
process.exit(0);
