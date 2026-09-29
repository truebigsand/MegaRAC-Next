// BMC read-only API probe — logs in once, GETs all v1-relevant endpoints, saves JSON samples.
// READ-ONLY: every request is GET, except POST /api/session (login) and DELETE /api/session
// (logout) — session management only, no configuration endpoints are ever called.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import fs from 'node:fs';
import path from 'node:path';
// ⚠️ 需要 BMC 凭据：先设置环境变量 BMC_PASS 再运行

const BMC = 'https://192.168.0.200';
const USER = process.env.BMC_USER || 'admin';
const PASS = process.env.BMC_PASS || '';
const OUT = 'reverse/samples';
fs.mkdirSync(OUT, { recursive: true });

async function req(method, url, { headers = {}, body } = {}) {
  const res = await fetch(BMC + url, {
    method,
    headers,
    body,
    redirect: 'manual',
  });
  const text = await res.text();
  return { status: res.status, headers: Object.fromEntries(res.headers), text };
}

// --- login ---
const form = new URLSearchParams({ username: USER, password: PASS });
const login = await req('POST', '/api/session', {
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: form.toString(),
});
console.log('LOGIN', login.status, login.text.slice(0, 300));
let csrf = '';
try { csrf = JSON.parse(login.text).CSRFToken || ''; } catch {}
const cookie = login.headers['set-cookie']?.split(';')[0] || '';
const authHeaders = { 'x-csrftoken': csrf, ...(cookie ? { Cookie: cookie } : {}) };

// --- endpoints to probe ---
const endpoints = [
  '/api/configuration/project',
  '/api/configuration/runtime',
  '/api/settings/users',
  '/api/settings/date-time',
  '/api/status/uptime',
  '/api/logs/dashboardevent',
  '/api/logs/event?LASTEVENTID=75',
  '/api/sensors',
  '/api/detail_sensors_readings',
  '/api/sdr',
  '/api/chassis-status',
  '/api/firmware-info',
  '/api/fru',
  '/api/settings/fru',
  '/api/settings/network',
  '/api/settings/network-link',
  '/api/settings/fanprofile/mode',
  '/api/settings/fanprofile/collection',
  '/api/settings/fanprofile/device_define/collection',
  '/api/dcmi/power',
  '/api/system_inventory_gbt/cmc_ip',
  '/api/system_inventory_gbt/bios_info',
  '/api/system_inventory_gbt/cpu_info',
  '/api/system_inventory_gbt/dimm_info',
  '/api/system_inventory_gbt/dimm_info_ex',
  '/api/system_inventory_gbt/hdd_info',
  '/api/system_inventory_gbt/nic_info',
  '/api/system_inventory_gbt/pci_info',
  '/api/system_inventory_gbt/cpld_info',
  '/api/host_inventory/host_interface_system_info',
  '/api/host_inventory/host_interface_thermal_info',
  '/api/host_inventory/host_interface_processor_info',
  '/api/host_inventory/host_interface_memory_info',
  '/api/host_inventory/host_interface_power_info',
  '/api/host_inventory/host_interface_storage_info',
  '/api/host_inventory/host_interface_baseboard_info',
  '/api/host_inventory/host_interface_pcie_device_function_info',
  '/api/oem/node_info',
  '/api/tasks',
  '/api/settings/services',
  '/api/settings/media/general',
  '/api/settings/mouse',
  '/api/settings/ssl/certificate-info',
  '/api/maintenance/dualflashimageconfig',
  '/api/remote_control/get/kvm/launch',
];

const results = {};
for (const ep of endpoints) {
  const name = ep.replace(/^\/api\//, '').replace(/[?&=]/g, '__').replace(/\//g, '_');
  try {
    const r = await req('GET', ep, { headers: authHeaders });
    const ct = r.headers['content-type'] || '';
    let body = r.text;
    if (ct.includes('json')) { try { body = JSON.stringify(JSON.parse(r.text)); } catch {} }
    const truncated = body.length > 4000 ? body.slice(0, 4000) + `...[truncated ${body.length}B total]` : body;
    results[ep] = { status: r.status, contentType: ct, body: truncated };
    console.log(r.status, ep);
  } catch (e) {
    results[ep] = { status: 'ERR', error: String(e) };
    console.log('ERR', ep, String(e).slice(0, 120));
  }
}

fs.writeFileSync(path.join(OUT, 'probe_results.json'), JSON.stringify(results, null, 2));

// --- logout ---
try { await req('DELETE', '/api/session', { headers: authHeaders }); console.log('LOGOUT ok'); } catch {}
console.log('DONE');
