// 诊断固件上传接口：用小文件试，区分"端点/格式不对"还是"文件太大"。
import { Agent, fetch as uFetch } from 'undici';
import { writeFileSync } from 'node:fs';

const HOST = '192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const raw = (p, o = {}) => uFetch(`https://${HOST}${p}`, { ...o, dispatcher: agent, signal: AbortSignal.timeout(o.timeoutMs || 120000) });

const lr = await raw('/api/session', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username: 'admin', password: process.env.BMC_PASS || '' }).toString(),
});
const login = await lr.json();
console.log('登录:', lr.status, 'ok=', login.ok);
const cookie = (lr.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
const h = { cookie, 'x-csrftoken': login.CSRFToken };

// 造一个 1KB 的假"固件"
const tiny = Buffer.alloc(1024, 0x41);
writeFileSync(new URL('../bmc_firmware/tiny_fake.bin', import.meta.url), tiny);

const variants = [
  ['小文件 + 字段名 fwimage', () => {
    const fd = new FormData();
    fd.append('fwimage', new Blob([tiny]), 'tiny_fake.bin');
    return { headers: h, body: fd };
  }],
  ['小文件 + 字段名 firmware_image', () => {
    const fd = new FormData();
    fd.append('firmware_image', new Blob([tiny]), 'tiny_fake.bin');
    return { headers: h, body: fd };
  }],
  ['小文件 + 纯二进制 body', () => ({ headers: { ...h, 'content-type': 'application/octet-stream' }, body: tiny })],
];

for (const [name, mk] of variants) {
  try {
    const opts = mk();
    const r = await raw('/api/maintenance/firmware', { method: 'POST', ...opts });
    const t = await r.text();
    console.log(`\n[${name}] → ${r.status}`);
    console.log('   ', t.replace(/\s+/g, ' ').slice(0, 300));
  } catch (e) {
    console.log(`\n[${name}] → 异常 ${e.name}`);
  }
}
process.exit(0);
