// 低成本探测：经典路径的请求形态是否被 BMC 接受。
// 只做 登录 → PUT /api/maintenance/flash → POST /api/maintenance/firmware(小文件) → 报告 → 退出。
// 目的是在传 66MB 之前先确认「请求形态」这一变量，而不是拿大文件去赌。
// 用法: BMC_PASS=... node reverse/flash_upload_probe.mjs [文件路径]
import { Agent, fetch as uFetch } from 'undici';
import { readFileSync, statSync } from 'node:fs';

const HOST = process.env.BMC_HOST || '192.168.0.200';
const FILE = process.argv[2] || 'bmc_firmware/tiny_fake.bin';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const raw = (p, o = {}) => uFetch(`https://${HOST}${p}`, { ...o, dispatcher: agent, signal: AbortSignal.timeout(o.t || 120000) });

// 登录（注意：form-urlencoded，不是 JSON）
const lr = await raw('/api/session', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username: 'admin', password: process.env.BMC_PASS }).toString(),
});
const login = await lr.json().catch(() => ({}));
if (lr.status !== 200 || login.ok !== 0) {
  console.log('登录失败', lr.status, JSON.stringify(login).slice(0, 200));
  process.exit(1);
}
const cookie = (lr.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
console.log('登录 OK，CSRFToken =', login.CSRFToken);
console.log('cookie:', cookie);

// 三种头部组合各试一次，定位到底哪个头是必需的
const variants = [
  { name: '原版形态(X-CSRFTOKEN + X-Requested-With)', h: { cookie, 'X-CSRFTOKEN': login.CSRFToken, 'X-Requested-With': 'XMLHttpRequest' } },
  { name: '仅 cookie', h: { cookie } },
  { name: '小写头(x-csrftoken)', h: { cookie, 'x-csrftoken': login.CSRFToken } },
];

// 刷写准备（每个组合前都重新进入，模拟原版）
for (const v of variants) {
  const fm = await raw('/api/maintenance/flash', {
    method: 'PUT',
    headers: { ...v.h, 'content-type': 'application/json' },
    body: '{}',
  });
  const fmtxt = await fm.text();
  console.log(`\n===== ${v.name} =====`);
  console.log(`  PUT flash → ${fm.status} ${fmtxt.slice(0, 160)}`);

  const stat = statSync(FILE);
  const fd = new FormData();
  fd.append('fwimage', new Blob([readFileSync(FILE)], { type: 'application/octet-stream' }), '126139.bin');
  const t0 = Date.now();
  try {
    const r = await raw('/api/maintenance/firmware', { method: 'POST', headers: v.h, body: fd, t: 120000 });
    const txt = await r.text();
    console.log(`  POST firmware（${stat.size} 字节）→ ${r.status} (${Date.now() - t0}ms)`);
    console.log(`  content-type: ${r.headers.get('content-type')}`);
    console.log(`  响应: ${txt.slice(0, 400).replace(/\s+/g, ' ')}`);
  } catch (e) {
    console.log(`  POST firmware → 异常 ${e.name}: ${e.message}`);
  }
}

console.log('\n探测结束（未触发刷写，镜像未生效）');
process.exit(0);
