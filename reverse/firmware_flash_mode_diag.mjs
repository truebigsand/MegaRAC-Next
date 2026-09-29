// 探明上传的前置条件：先 PUT /api/maintenance/flash（进入刷写模式），再试上传小文件。
// 仅做诊断：用 1KB 垃圾文件，不会真的刷写。
import { Agent, fetch as uFetch } from 'undici';
import { readFileSync } from 'node:fs';

const HOST = '192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const raw = (p, o = {}) => uFetch(`https://${HOST}${p}`, { ...o, dispatcher: agent, signal: AbortSignal.timeout(o.timeoutMs || 120000) });
const brief = (t) => t.replace(/\s+/g, ' ').slice(0, 240);

const lr = await raw('/api/session', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username: 'admin', password: process.env.BMC_PASS || '' }).toString(),
});
const login = await lr.json();
const cookie = (lr.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
const h = { cookie, 'x-csrftoken': login.CSRFToken };
console.log('登录 ok=', login.ok);

// 0) 先看当前 flash 状态
try {
  const g = await raw('/api/maintenance/flash', { headers: h });
  console.log('GET /api/maintenance/flash →', g.status, brief(await g.text()));
} catch (e) {
  console.log('GET /api/maintenance/flash 异常', e.name);
}

// 1) 进入刷写模式
try {
  const f = await raw('/api/maintenance/flash', { method: 'PUT', headers: { ...h, 'content-type': 'application/json' }, body: '{}' });
  console.log('PUT /api/maintenance/flash →', f.status, brief(await f.text()));
} catch (e) {
  console.log('PUT /api/maintenance/flash 异常', e.name);
}

// 2) 再试上传小文件
const tiny = readFileSync('C:/path/to/MegaRAC-Next/bmc_firmware/tiny_fake.bin');
const fd = new FormData();
fd.append('fwimage', new Blob([tiny]), 'tiny_fake.bin');
try {
  const u = await raw('/api/maintenance/firmware', { method: 'POST', headers: h, body: fd });
  console.log('上传小文件 →', u.status, brief(await u.text()));
} catch (e) {
  console.log('上传异常', e.name);
}

// 3) 看看 flash 状态与固件信息
try {
  const g2 = await raw('/api/maintenance/flash', { headers: h });
  console.log('再查 flash 状态 →', g2.status, brief(await g2.text()));
} catch (e) {
  console.log('再查异常', e.name);
}
try {
  const v = await raw('/api/maintenance/firmware/verification?flash_type=BMC', { headers: h });
  console.log('verification →', v.status, brief(await v.text()));
} catch (e) {
  console.log('verification 异常', e.name);
}
process.exit(0);
