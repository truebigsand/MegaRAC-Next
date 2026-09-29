// 精确对比升级前后的配置：区分「真正的配置变化」与「新固件新增字段/键顺序/计数器」。
import { Agent, fetch as uFetch } from 'undici';
import fs from 'node:fs';

const HOST = process.env.BMC_HOST || '192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const raw = (p, o = {}) => uFetch(`https://${HOST}${p}`, { ...o, dispatcher: agent, signal: AbortSignal.timeout(o.t || 40000) });

const lr = await raw('/api/session', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username: 'admin', password: process.env.BMC_PASS }).toString(),
});
const login = await lr.json();
const H = { cookie: (lr.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; '), 'X-CSRFTOKEN': login.CSRFToken, 'X-Requested-With': 'XMLHttpRequest' };
const get = async (p) => (await raw(p, { headers: H })).json();

const snap = JSON.parse(fs.readFileSync('reverse/pre_upgrade_snapshot.json', 'utf8'));

// 递归找出「值不同 / 新增 / 消失」的叶子字段
const diffs = [];
const walk = (a, b, path) => {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push({ path, before: a, after: b });
    return;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!(k in a)) { diffs.push({ path: `${path}.${k}`, before: '(无)', after: b[k], note: '新固件新增' }); continue; }
    if (!(k in b)) { diffs.push({ path: `${path}.${k}`, before: a[k], after: '(无)', note: '新固件移除' }); continue; }
    walk(a[k], b[k], `${path}.${k}`);
  }
};

const TARGETS = [
  ['settings/network', '/api/settings/network'],
  ['settings/users', '/api/settings/users'],
  ['settings/services', '/api/settings/services'],
  ['settings/date-time', '/api/settings/date-time'],
  ['settings/fanprofile/mode', '/api/settings/fanprofile/mode'],
  ['settings/fanprofile/collection', '/api/settings/fanprofile/collection'],
  ['settings/media/general', '/api/settings/media/general'],
  ['settings/media/remotesession', '/api/settings/media/remotesession'],
  ['settings/media/adviser', '/api/settings/media/adviser'],
];
for (const [key, path] of TARGETS) {
  diffs.length = 0;
  const before = snap[key]?.data;
  const after = await get(path);
  walk(before, after, '');
  console.log(`\n=== ${path} —— 差异 ${diffs.length} 处 ===`);
  for (const d of diffs.slice(0, 25)) {
    console.log(`  ${d.path}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}${d.note ? '  [' + d.note + ']' : ''}`);
  }
  if (diffs.length === 0) console.log('  （完全一致）');
}
process.exit(0);
