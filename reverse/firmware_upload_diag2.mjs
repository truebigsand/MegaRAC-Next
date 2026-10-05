// 诊断上传被秒拒的原因：逐个试 header / 字段名组合（都用 1KB 垃圾文件）。
// 结束会把 BMC 留在刷写模式，它会自行超时恢复（实测约 45 秒）。
import { Agent, fetch as uFetch } from 'undici';
import { readFileSync } from 'node:fs';

const HOST = '192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const raw = (p, o = {}) => uFetch(`https://${HOST}${p}`, { ...o, dispatcher: agent, signal: AbortSignal.timeout(o.timeoutMs || 120000) });
const brief = (t) => t.replace(/\s+/g, ' ').slice(0, 180);

const lr = await raw('/api/session', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username: 'admin', password: process.env.BMC_PASS || '' }).toString(),
});
const login = await lr.json();
const cookie = (lr.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
const h = { cookie, 'x-csrftoken': login.CSRFToken };
console.log('登录 ok=', login.ok);

const fm = await raw('/api/maintenance/flash', { method: 'PUT', headers: { ...h, 'content-type': 'application/json' }, body: '{}' });
console.log('进入刷写模式 →', fm.status, brief(await fm.text()));

const tiny = readFileSync(new URL('../bmc_firmware/tiny_fake.bin', import.meta.url));
const xhrHeaders = {
  accept: 'application/json, text/javascript, */*; q=0.01',
  'x-requested-with': 'XMLHttpRequest',
};

const cases = [
  ['fwimage + XHR 头', 'fwimage', { ...h, ...xhrHeaders }],
  ['fwimage + 仅 accept', 'fwimage', { ...h, accept: xhrHeaders.accept }],
  ['fwimage（无附加头）', 'fwimage', { ...h }],
  ['image + XHR 头', 'image', { ...h, ...xhrHeaders }],
  ['file + XHR 头', 'file', { ...h, ...xhrHeaders }],
];

for (const [name, field, headers] of cases) {
  const fd = new FormData();
  fd.append(field, new Blob([tiny]), 'tiny_fake.bin');
  try {
    const t = Date.now();
    const r = await raw('/api/maintenance/firmware', { method: 'POST', headers, body: fd });
    console.log(`\n[${name}] → ${r.status}（${Date.now() - t}ms）`);
    console.log('   ', brief(await r.text()));
  } catch (e) {
    console.log(`\n[${name}] → 异常 ${e.name}`);
  }
}
process.exit(0);
