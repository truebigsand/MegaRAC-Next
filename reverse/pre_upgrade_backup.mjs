// 升级 BMC 固件前的状态快照 + 配置备份（只读为主）。
// 用途：万一升级重置了配置，可以照着这份快照恢复（尤其是网络 IP 与风扇档案）。
import { Agent, fetch as uFetch } from 'undici';
import { writeFileSync } from 'node:fs';

const HOST = '192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const req = (p, o = {}) =>
  uFetch(`https://${HOST}${p}`, {
    ...o,
    dispatcher: agent,
    headers: { 'content-type': 'application/json', ...(o.headers || {}) },
    signal: AbortSignal.timeout(60000),
  });

const r = await req('/api/session', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username: 'admin', password: process.env.BMC_PASS || '' }).toString(),
});
const login = await r.json();
const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
const h = { cookie, 'x-csrftoken': login.CSRFToken };
const get = async (p) => {
  try {
    const res = await req('/api/' + p, { headers: h });
    const t = await res.text();
    try {
      return { status: res.status, data: JSON.parse(t) };
    } catch {
      return { status: res.status, text: t.slice(0, 200) };
    }
  } catch (e) {
    return { error: e.name };
  }
};

const snapshot = {};
for (const p of [
  'firmware-info',
  'settings/network',
  'settings/users',
  'settings/services',
  'settings/date-time',
  'settings/fanprofile/mode',
  'settings/fanprofile/collection',
  'settings/media/general',
  'settings/media/remotesession',
  'settings/media/adviser',
  'settings/IPAccessControl',
  'settings/firewall',
  'settings/port_firewall',
  'maintenance/dual_image_config',
  'maintenance/dualflashimageconfig',
  'settings/preserve_configuration',
]) {
  snapshot[p] = await get(p);
  const s = snapshot[p];
  const brief = s.data ? JSON.stringify(s.data).slice(0, 160) : s.text || s.error || `HTTP ${s.status}`;
  console.log(`[${p}] ${brief}`);
}

writeFileSync('C:/path/to/MegaRAC-Next/reverse/pre_upgrade_snapshot.json', JSON.stringify(snapshot, null, 2));
console.log('\n快照已写入 reverse/pre_upgrade_snapshot.json');

// 让 BMC 生成一份配置备份（不改配置本身）
try {
  const b = await req('/api/maintenance/backup_config', { method: 'POST', headers: h, body: '{}' });
  console.log('backup_config →', b.status, (await b.text()).slice(0, 200));
  const d = await req('/api/maintenance/download_config', { headers: h });
  console.log('download_config →', d.status, d.headers.get('content-type'), d.headers.get('content-length'));
  if (d.status === 200) {
    const buf = Buffer.from(await d.arrayBuffer());
    writeFileSync('C:/path/to/MegaRAC-Next/reverse/bmc_config_backup.bin', buf);
    console.log('备份已保存 reverse/bmc_config_backup.bin', buf.length, '字节');
  }
} catch (e) {
  console.log('配置备份失败:', e.name);
}
process.exit(0);
