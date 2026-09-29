// 安全检查（只读）：暴露面、协议开关、账号、时间同步。
import { Agent, fetch as uFetch } from 'undici';

const HOST = '192.168.0.200';
const agent = new Agent({ connect: { rejectUnauthorized: false } });
const req = (p, o = {}) =>
  uFetch(`https://${HOST}${p}`, {
    ...o,
    dispatcher: agent,
    headers: { 'content-type': 'application/json', ...(o.headers || {}) },
    signal: AbortSignal.timeout(40000),
  });

const r = await req('/redfish/v1/SessionService/Sessions', {
  method: 'POST',
  body: JSON.stringify({ UserName: 'admin', Password: process.env.BMC_PASS || '' }),
});
const h = { 'x-auth-token': r.headers.get('x-auth-token') };
const get = async (p) => {
  try {
    const res = await req(p, { headers: h });
    return res.status === 200 ? await res.json() : { __status: res.status };
  } catch (e) {
    return { __err: e.name };
  }
};

// 1) 网口 + 主机接口（CVE-2024-54085 打的是 Redfish Host Interface）
const eth = await get('/redfish/v1/Managers/Self/EthernetInterfaces');
console.log('== 网口 ==');
for (const m of eth.Members || []) {
  const d = await get(m['@odata.id']);
  console.log(
    `  ${d.Name || d.Id}: ${d.InterfaceEnabled ? '启用' : '停用'} IPv4=${d.IPv4Addresses?.[0]?.Address || '-'}` +
      ` DHCP=${d.DHCPv4?.DHCPEnabled} 主机接口=${d.InterfaceType || '?'}`,
  );
}

// 2) 协议
const np = await get('/redfish/v1/Managers/Self/NetworkProtocol');
console.log('== 协议开关 ==');
for (const [k, v] of Object.entries(np)) {
  if (v && typeof v === 'object' && 'ProtocolEnabled' in v) {
    console.log(`  ${k}: ${v.ProtocolEnabled ? '启用' : '停用'}${v.Port ? ' 端口 ' + v.Port : ''}`);
  }
}

// 3) 账号
const acc = await get('/redfish/v1/AccountService/Accounts');
console.log('== 账号 ==');
for (const m of acc.Members || []) {
  const d = await get(m['@odata.id']);
  console.log(`  ${d.UserName || d.Id}: 角色=${d.RoleId || '-'} 启用=${d.Enabled} 锁定=${d.Locked || false}`);
}

// 4) BMC 自身时间（日志时间戳的水位线）
const mgr = await get('/redfish/v1/Managers/Self');
console.log('== BMC 时间 ==', mgr.DateTime || '(未提供)', '| 时区', mgr.DateTimeLocalOffset || '-');

// 5) 固件清单（看 BMC 自己报的版本）
const fw = await get('/redfish/v1/UpdateService/FirmwareInventory');
console.log('== 固件清单 ==');
for (const m of (fw.Members || []).slice(0, 6)) {
  const d = await get(m['@odata.id']);
  console.log(`  ${d.Name || d.Id}: ${d.Version}`);
}

const sess = await get('/redfish/v1/SessionService/Sessions');
for (const m of sess.Members || []) await req(m['@odata.id'], { method: 'DELETE', headers: h });
console.log('（Redfish 会话已注销）');
process.exit(0);
