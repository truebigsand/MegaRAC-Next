// 验证「客户端 abort 掉超时请求 → BMC 作废该 Redfish 会话 → 后续 401」这个假设。
// 若成立，则 Redfish 完全可以当作数据层用，只要代理端：不轻易 abort + 超时后重新登录。
import { Agent, fetch as uFetch } from 'undici';

const HOST = process.env.BMC_HOST || '192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const raw = (p, o = {}) => uFetch(`https://${HOST}${p}`, { ...o, dispatcher: agent, signal: AbortSignal.timeout(o.t || 60000) });

const login = async () => {
  const r = await raw('/redfish/v1/SessionService/Sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ UserName: 'admin', Password: process.env.BMC_PASS }), t: 30000,
  });
  return r.headers.get('x-auth-token');
};
const hit = async (H, p, t = 30000) => {
  const t0 = Date.now();
  try { const r = await raw(p, { headers: H, t }); const txt = await r.text();
    const j = txt.startsWith('{') ? JSON.parse(txt) : null;
    return `${r.status}${j?.FirmwareVersion ? ' ' + j.FirmwareVersion : ''}${j?.Name ? ' ' + j.Name : ''} (${Date.now() - t0}ms)`; }
  catch (e) { return `${e.name} (${Date.now() - t0}ms)`; }
};

// --- 实验 1：正常会话 + 一次短超时 abort，然后立刻用同一会话再取 ---
let tok = await login();
let H = { 'x-auth-token': tok };
console.log('实验 1：短超时 abort 是否会毒化会话');
console.log('  1) 先正常取一次 Managers/Self  →', await hit(H, '/redfish/v1/Managers/Self'));
console.log('  2) 用 3 秒超时取 Chassis（大概率 abort）→', await hit(H, '/redfish/v1/Chassis', 3000));
console.log('  3) 再取 Managers/Self（同会话）→', await hit(H, '/redfish/v1/Managers/Self', 30000));
console.log('  4) 再取一次（同会话）        →', await hit(H, '/redfish/v1/Managers/Self', 30000));

// --- 实验 2：重新登录是否立即恢复 ---
console.log('\n实验 2：重新登录是否恢复');
tok = await login();
H = { 'x-auth-token': tok };
console.log('  新会话取 Systems →', await hit(H, '/redfish/v1/Systems', 90000));
console.log('  新会话取 Managers/Self →', await hit(H, '/redfish/v1/Managers/Self'));

// --- 实验 3：不 abort（超时给足）能否拿到那些"爱挂"的资源 ---
console.log('\n实验 3：给足 120 秒超时，看爱挂的资源是否只是慢');
for (const p of ['/redfish/v1/Chassis', '/redfish/v1/UpdateService', '/redfish/v1/AccountService/Accounts']) {
  console.log(`  ${p} →`, await hit(H, p, 120000));
}
await raw(`/redfish/v1/SessionService/Sessions/${tok}`, { method: 'DELETE', headers: H }).catch(() => {});
process.exit(0);
