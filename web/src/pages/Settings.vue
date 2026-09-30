<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  NAlert,
  NButton,
  NDataTable,
  NDescriptions,
  NDescriptionsItem,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NModal,
  NPopconfirm,
  NSelect,
  NSpace,
  NSwitch,
  NTabPane,
  NTabs,
  NTag,
  useMessage,
} from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import { bmcGet, bmcSend } from '../api';
import { useIsMobile } from '../useMediaQuery';

const isMobile = useIsMobile();
/** 首次加载中（BMC 慢时可能要十几秒，别让表格显示成「无数据」） */
const tableLoading = ref(true);
const message = useMessage();
const clearing = ref(false);

/**
 * 清理 BMC 上除本代理以外的会话（只删会话记录，不动配置）。
 * BMC 会话表只有 148 格，占满后新登录会被拒，这里给一个 UI 上的自救入口。
 */
async function clearBmcSessions() {
  clearing.value = true;
  try {
    const res = await fetch('/api/maintenance/clear-bmc-sessions', { method: 'POST' });
    const data = (await res.json()) as { ok?: boolean; report?: Record<string, { removed: number }> };
    if (!res.ok) throw new Error('清理失败');
    const removed = Object.values(data.report ?? {}).reduce((a, r) => a + (r.removed ?? 0), 0);
    message.success(`已清理 ${removed} 个僵尸会话`);
    await refresh();
  } catch (e) {
    message.error((e as Error).message);
  } finally {
    clearing.value = false;
  }
}

/** 各写操作共用的提交状态 */
const saving = ref(false);
/** 用户在「日期时间」页签改过内容后，自动刷新不再覆盖表单 */
const dtDirty = ref(false);

/** 统一的写操作封装：确认由调用方负责，这里只管提交与刷新 */
async function submitWrite(
  label: string,
  path: string,
  body: unknown,
  method: 'POST' | 'PUT' | 'DELETE' = 'PUT',
) {
  saving.value = true;
  try {
    await bmcSend(method, path, body);
    message.success(`${label}成功`);
    await refresh();
    return true;
  } catch (e) {
    message.error(`${label}失败：${(e as Error).message}`);
    return false;
  } finally {
    saving.value = false;
  }
}

// ---------- 用户 ----------
const userDialog = ref(false);
const userForm = ref({ userid: 0, name: '', password: '', privilege: 'user', kvm: 1, vmedia: 1 });
const userIsNew = ref(false);
/**
 * 写回时要用 BMC 自己给的那个对象整体回写（只改我们动的几个字段）。
 * 实测只发 name/privilege/password 这样的最小体会 500——它期望模型字段齐全。
 */
const userBase = ref<BmcUser | null>(null);

function openUserEdit(u: BmcUser) {
  userIsNew.value = false;
  userBase.value = { ...u };
  userForm.value = {
    userid: u.userid,
    name: u.name,
    password: '',
    privilege: u.privilege || 'user',
    kvm: u.kvm ? 1 : 0,
    vmedia: u.vmedia ? 1 : 0,
  };
  userDialog.value = true;
}

function openUserCreate() {
  // BMC 的用户是**固定槽位**（id 1..N）：新建 = 往一个空槽 PUT，
  // 而不是 POST 集合（实测 POST /api/settings/users 返回 404）
  const used = new Set(users.value.filter((u) => u.name).map((u) => u.userid));
  const free = users.value.map((u) => u.userid).filter((id) => !used.has(id)).sort((a, b) => a - b)[0];
  if (free === undefined) {
    message.warning('没有空闲用户槽位');
    return;
  }
  userIsNew.value = true;
  const slot = users.value.find((u) => u.userid === free);
  userBase.value = slot ? { ...slot } : null;
  userForm.value = { userid: free, name: '', password: '', privilege: 'user', kvm: 1, vmedia: 1 };
  userDialog.value = true;
}

async function saveUser() {
  const f = userForm.value;
  if (!f.name.trim()) {
    message.warning('用户名不能为空');
    return;
  }
  if (userIsNew.value && f.password.length < 8) {
    message.warning('BMC 要求密码至少 8 位');
    return;
  }
  const base = (userBase.value ?? {}) as BmcUser;
  const priv = f.privilege;
  // 字段与取值照抄 BMC 自己的 users 保存逻辑（viewer 的 users_edit_item.save）：
  // UserOperation 0=新增 1=修改；accessByChannel / privilegeByChannel 按通道拼串。
  const body: Record<string, unknown> = {
    ...base,
    name: f.name,
    UserOperation: userIsNew.value ? 0 : 1,
    password: f.password,
    confirm_password: f.password,
    password_size: f.password.length,
    privilege: priv,
    accessByChannel: '(1,1)',
    privilegeByChannel: `(${priv},${priv})`,
    snmp_access: (base.snmp_access as string) ?? '',
    snmp_authentication_protocol: (base.snmp_authentication_protocol as string) ?? '',
    snmp_privacy_protocol: (base.snmp_privacy_protocol as string) ?? '',
    email_id: (base.email_id as string) ?? '',
    email_format: (base.email_format as string) ?? 'ami_format',
    ssh_key: base.ssh_key === 'Not Available' ? '' : ((base.ssh_key as string) ?? ''),
  };
  const ok = await submitWrite(
    userIsNew.value ? '新建用户' : '保存用户',
    `settings/users/${base.id ?? f.userid}`,
    body,
    'PUT',
  );
  if (ok) userDialog.value = false;
}

async function deleteUser(u: BmcUser) {
  // 照抄 BMC 的删除实现：DELETE /api/settings/users/<id>，body 为 {snmp_status, id}
  await submitWrite(
    '删除用户',
    `settings/users/${u.id ?? u.userid}`,
    { snmp_status: u.snmp ?? 0, id: u.id ?? u.userid },
    'DELETE',
  );
}

// ---------- 服务 ----------
const serviceDialog = ref(false);
const serviceForm = ref({ id: 0, service_name: '', state: 1, time_out: 1800, maximum_sessions: 148 });
/** BMC 给的服务对象，写回时整体带上（端口/接口等字段它也要） */
const serviceBase = ref<Record<string, unknown> | null>(null);

function openServiceEdit(sv: BmcService) {
  serviceBase.value = { ...(sv as unknown as Record<string, unknown>) };
  serviceForm.value = {
    id: sv.id,
    service_name: sv.service_name,
    state: sv.state,
    time_out: sv.time_out,
    maximum_sessions: sv.maximum_sessions,
  };
  serviceDialog.value = true;
}

async function saveService() {
  const f = serviceForm.value;
  const base = serviceBase.value ?? {};
  // 字段照 BMC 自己的 services 保存逻辑：state/interface_name/两个端口/time_out/
  // maximum_sessions/active_session 一起回写
  const ok = await submitWrite(
    '保存服务',
    `settings/services/${base.id ?? f.id}`,
    {
      ...base,
      state: f.state,
      time_out: f.time_out,
      maximum_sessions: f.maximum_sessions,
      active_session: (base.active_session as number) ?? 0,
    },
    'PUT',
  );
  if (ok) serviceDialog.value = false;
}

// ---------- 网络（高危：写错会失联） ----------
const netDialog = ref(false);
const netForm = ref({
  id: 0,
  interface_name: '',
  ipv4_enable: 1,
  ipv4_dhcp_enable: 0,
  ipv4_address: '',
  ipv4_subnet: '',
  ipv4_gateway: '',
});

function openNetEdit(n: NetIf) {
  netForm.value = {
    id: n.id,
    interface_name: n.interface_name,
    ipv4_enable: n.ipv4_enable,
    ipv4_dhcp_enable: n.ipv4_dhcp_enable,
    ipv4_address: n.ipv4_address,
    ipv4_subnet: n.ipv4_subnet,
    ipv4_gateway: n.ipv4_gateway,
  };
  netDialog.value = true;
}

async function saveNet() {
  const f = netForm.value;
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (f.ipv4_dhcp_enable !== 1) {
    if (!ipv4.test(f.ipv4_address)) {
      message.warning('IPv4 地址格式不正确');
      return;
    }
    if (f.ipv4_subnet && !ipv4.test(f.ipv4_subnet)) {
      message.warning('掩码格式不正确（例如 255.255.255.0）');
      return;
    }
    if (f.ipv4_gateway && !ipv4.test(f.ipv4_gateway)) {
      message.warning('网关格式不正确');
      return;
    }
  }
  const ok = await submitWrite('保存网络设置', `settings/network/${f.id}`, {
    ipv4_enable: f.ipv4_enable,
    ipv4_dhcp_enable: f.ipv4_dhcp_enable,
    ipv4_address: f.ipv4_address,
    ipv4_subnet: f.ipv4_subnet,
    ipv4_gateway: f.ipv4_gateway,
  });
  if (ok) netDialog.value = false;
}

// ---------- 日期时间 ----------
const dtForm = ref({ timezone: '', ntp_auto_date: 0, primary_ntp: '', secondary_ntp: '' });

/** 常用时区（完整列表来自浏览器内置的 IANA 时区库，这里只保证这几个好找） */
const TZ_COMMON = [
  'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Tokyo', 'Asia/Singapore',
  'UTC', 'Europe/London', 'America/Los_Angeles', 'America/New_York',
];

/**
 * 某时区当前的 UTC 偏移（分钟，东为正）。
 * ⚠️ BMC 自己不会从时区名算偏移——原版前端是用 moment-timezone 算好再放进 utc_minutes 的，
 * 我们必须自己算，否则写入的时区与偏移不一致（实测填充名却没填偏移会失败）。
 */
function tzOffsetMinutes(zone: string): number {
  try {
    const name =
      new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
        .formatToParts(new Date())
        .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
    if (!m) return 0; // 纯 "GMT"/"UTC"
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
  } catch {
    return 0;
  }
}

const fmtOffset = (min: number) =>
  `UTC${min >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(min) / 60)).padStart(2, '0')}:${String(Math.abs(min) % 60).padStart(2, '0')}`;

const tzOptions = computed(() => {
  let all: string[] = [];
  try {
    all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    /* 老浏览器没有这个 API，只用常用列表 */
  }
  const set = new Set<string>([...TZ_COMMON, ...all, dtForm.value.timezone].filter(Boolean));
  return [...set].map((z) => ({ value: z, label: `${z}（${fmtOffset(tzOffsetMinutes(z))}）` }));
});

/** 实测可用的 NTP 服务器。⚠️ 这台 BMC 解析不了主机名，服务器必须填 IP。 */
const NTP_PRESETS = [
  { label: '203.107.6.88（阿里，实测可用）', value: '203.107.6.88' },
  { label: '120.25.115.20（阿里，实测可用）', value: '120.25.115.20' },
  { label: '210.72.145.44（国家授时中心）', value: '210.72.145.44' },
];

/** BMC 自报的 NTP 状态：2 = 服务器无效（不可达或无法解析） */
const ntpState = computed(() => {
  const v = datetime.value?.ntp_auto_date;
  if (v === 1) return { type: 'success' as const, text: '已启用' };
  if (v === 2) return { type: 'error' as const, text: '服务器无效（不可达或无法解析）' };
  return { type: 'default' as const, text: '未启用' };
});

const dtNowText = computed(() => {
  const t = datetime.value?.timestamp;
  return t ? new Date(t * 1000).toLocaleString('zh-CN') : '—';
});

function resetDateTime() {
  dtDirty.value = false;
  const d = datetime.value;
  dtForm.value = {
    timezone: d?.timezone ?? '',
    ntp_auto_date: d?.ntp_auto_date ?? 0,
    primary_ntp: d?.primary_ntp ?? '',
    secondary_ntp: d?.secondary_ntp ?? '',
  };
}

async function saveDateTime() {
  const f = dtForm.value;
  // 表单还没加载到数据时禁止保存，否则会把空时区/空 NTP 写进 BMC
  if (!datetime.value) {
    message.warning('还没取到当前时间设置，请稍后重试');
    return;
  }
  const tz = f.timezone.trim();
  if (!tz) {
    message.warning('请选择时区');
    return;
  }
  const primary = f.primary_ntp.trim();
  const secondary = f.secondary_ntp.trim();
  if (f.ntp_auto_date === 1 && !primary) {
    message.warning('启用 NTP 时必须填主 NTP 服务器');
    return;
  }
  if (f.ntp_auto_date === 1 && !/^\d{1,3}(\.\d{1,3}){3}$/.test(primary)) {
    message.warning('NTP 服务器请填 IP 地址：这台 BMC 解析不了主机名（没配 DNS），填域名会被整体拒绝');
    return;
  }
  // 写入体照原版：时区名 + mode（纯 GMT/UTC 偏移为 1）+ utc_minutes（**必须自己算好**）
  // + timestamp: -1（表示不改时钟，只改时区/NTP）
  const body = {
    timezone: tz,
    mode: /GMT|UTC/i.test(tz) ? 1 : 0,
    utc_minutes: tzOffsetMinutes(tz),
    timestamp: -1,
    ntp_auto_date: f.ntp_auto_date,
    primary_ntp: primary,
    secondary_ntp: secondary,
  };
  saving.value = true;
  try {
    await bmcSend('PUT', 'settings/date-time', body);
    message.success('保存时间设置成功');
    dtDirty.value = false;
    await refresh();
  } catch (e) {
    const msg = (e as Error).message ?? '';
    // BMC 把"NTP 服务器不可达/不能解析"和时区写入打成一个错，这里把真实原因说清楚
    if (/NTP/i.test(msg)) {
      message.error(
        `保存失败：${msg} 原因通常是 NTP 服务器不可达或无法解析——这台 BMC 没有 DNS，服务器必须填 IP（实测 203.107.6.88 可用）。`,
        { duration: 8000 },
      );
    } else {
      message.error(`保存时间设置失败：${msg}`);
    }
  } finally {
    saving.value = false;
  }
}

interface FruDevice {
  device: { id: number; name: string };
  chassis?: { type: string; part_number: string; serial_number: string };
  board?: { date: string; manufacturer: string; product_name: string; serial_number: string; part_number: string };
  product?: { manufacturer: string; product_name: string; part_number: string; product_version: string; serial_number: string; asset_tag: string };
}
interface BmcUser {
  id: number;
  userid: number;
  channel: number;
  name: string;
  access: number;
  privilege: string;
  kvm: number;
  vmedia: number;
  ssh_key: string;
  /** BMC 返回的其它字段（channel/email_format/creation_time 等），写回时要原样带回 */
  [k: string]: unknown;
}
interface NetIf {
  id: number;
  interface_name: string;
  mac_address: string;
  ipv4_enable: number;
  ipv4_dhcp_enable: number;
  ipv4_address: string;
  ipv4_subnet: string;
  ipv4_gateway: string;
  ipv6_enable: number;
  ipv6_dhcp_enable: number;
  ipv6_address: string;
  vlan_enable: number;
  vlan_id: number;
}
interface BmcService {
  id: number;
  service_name: string;
  state: number;
  time_out: number;
  non_secure_port: number;
  secure_port: number;
  maximum_sessions: number;
  active_session: number;
}

const users = ref<BmcUser[]>([]);
const network = ref<NetIf[]>([]);
const services = ref<BmcService[]>([]);
/**
 * BMC 自报的 active_session 是**假的**（实测冷重置后立刻显示 web 130/148、kvm 128/130，
 * 而真实会话列表是 0 条）。真正有意义的是 /settings/service-sessions 的条数，
 * 所以这里单独取一份按 session_type 统计的真实值。
 */
// null = 还没取到（显示 —）；{} = 已取到且确实没有会话（显示 0）
const realSessions = ref<Record<string, number> | null>(null);
const SESSION_TYPE_NAME: Record<number, string> = {
  1: 'web', 2: 'kvm', 3: 'cd-media', 4: 'hd-media', 5: 'kvm', 6: 'ssh',
};
const datetime = ref<{
  primary_ntp: string;
  secondary_ntp: string;
  ntp_auto_date: number;
  timezone: string;
  timestamp: number;
  utc_minutes: number;
} | null>(null);
/** GET 到的日期时间原始对象（写回时整体带上） */
let timer: ReturnType<typeof setInterval> | null = null;

const userColumns: DataTableColumns<BmcUser> = [
  { title: 'ID', key: 'userid', width: 60 },
  { title: '用户名', key: 'name', width: 140 },
  {
    title: '权限',
    key: 'privilege',
    width: 140,
    render: (u) =>
      u.privilege === 'administrator'
        ? h_tag(u.privilege, 'success')
        : u.privilege === 'none'
          ? h_tag(u.privilege, 'default')
          : h_tag(u.privilege, 'info'),
  },
  { title: 'KVM', key: 'kvm', width: 80, render: (u) => (u.kvm ? '✓' : '—') },
  { title: '虚拟媒体', key: 'vmedia', width: 90, render: (u) => (u.vmedia ? '✓' : '—') },
  { title: 'SSH 公钥', key: 'ssh_key', ellipsis: { tooltip: true }, render: (u) => (u.ssh_key === 'Not Available' ? '—' : u.ssh_key) },
  {
    title: '操作',
    key: 'op',
    width: 150,
    render: (u) =>
      h(NSpace, { size: 4 }, {
        default: () => [
          h(NButton, { size: 'tiny', onClick: () => openUserEdit(u) }, { default: () => '编辑' }),
          h(
            NPopconfirm,
            { onPositiveClick: () => deleteUser(u) },
            {
              trigger: () => h(NButton, { size: 'tiny', type: 'error', quaternary: true }, { default: () => '删除' }),
              default: () => `删除用户「${u.name}」？此操作不可撤销。`,
            },
          ),
        ],
      }),
  },
];

function h_tag(text: string, type: 'success' | 'default' | 'info') {
  const color = type === 'success' ? '#63e2b7' : type === 'info' ? '#70c0e8' : '#888';
  return h('span', { style: `color:${color}` }, text);
}

const netColumns: DataTableColumns<NetIf> = [
  { title: '接口', key: 'interface_name', width: 100 },
  { title: 'MAC', key: 'mac_address', width: 170 },
  { title: 'IPv4', key: 'ipv4_address', width: 150 },
  { title: '掩码', key: 'ipv4_subnet', width: 140 },
  { title: '网关', key: 'ipv4_gateway', width: 140 },
  {
    title: 'DHCP',
    key: 'ipv4_dhcp_enable',
    width: 80,
    render: (n) => (n.ipv4_dhcp_enable ? 'DHCP' : '静态'),
  },
  { title: 'IPv6', key: 'ipv6_address' },
  {
    title: '操作',
    key: 'op',
    width: 90,
    render: (n) =>
      h(NButton, { size: 'tiny', type: 'warning', onClick: () => openNetEdit(n) }, { default: () => '编辑' }),
  },
];

const serviceColumns: DataTableColumns<BmcService> = [
  { title: '服务', key: 'service_name', width: 120 },
  {
    title: '状态',
    key: 'state',
    width: 80,
    render: (s) => (s.state ? h_tag('启用', 'success') : h_tag('禁用', 'default')),
  },
  { title: 'HTTP 端口', key: 'non_secure_port', width: 100 },
  { title: 'HTTPS 端口', key: 'secure_port', width: 100 },
  {
    title: '会话 当前/上限',
    key: 'sess',
    render: (s) => {
      const known = realSessions.value;
      const cur = known ? (known[s.service_name] ?? 0) : '—';
      return `${cur} / ${s.maximum_sessions}`;
    },
  },
  {
    title: '操作',
    key: 'op',
    width: 90,
    render: (sv) =>
      h(NButton, { size: 'tiny', onClick: () => openServiceEdit(sv) }, { default: () => '编辑' }),
  },
];

async function loadRealSessions() {
  try {
    const list = await bmcGet<{ session_type?: number }[]>('settings/service-sessions');
    const byType: Record<string, number> = {};
    for (const e of Array.isArray(list) ? list : []) {
      const name = SESSION_TYPE_NAME[e.session_type ?? -1];
      if (name) byType[name] = (byType[name] ?? 0) + 1;
    }
    realSessions.value = byType;
  } catch {
    realSessions.value = null; // 取不到就显示 —，绝不显示 BMC 那个假计数器
  }
}

async function refresh() {
  void loadRealSessions(); // 会话真实条数单独取，取不到不影响其它页签
  try {
    const [usersData, netData, svcData, dtData] = await Promise.all([
      bmcGet<BmcUser[]>('settings/users'),
      bmcGet<NetIf[]>('settings/network'),
      bmcGet<BmcService[]>('settings/services'),
      bmcGet<{ primary_ntp: string; secondary_ntp: string; ntp_auto_date: number; timezone: string; timestamp: number; utc_minutes: number }>('settings/date-time'),
    ]);
    // ⚠️ BMC 的 /settings/users 会**按通道各返回一份**（本机实测 32 条 = 16 用户 × 2 通道：
    // channel 1=web/KVM、channel 2=IPMI），两份都渲染会让每个用户在表里出现两次。
    // 这里按 userid 归并、取通道号最小的那份（即本页可编辑的 web/KVM 通道）。
    const byUser = new Map<number, BmcUser>();
    for (const u of usersData) {
      if (u.privilege === undefined) continue;
      const cur = byUser.get(u.userid);
      if (!cur || u.channel < cur.channel) byUser.set(u.userid, u);
    }
    users.value = [...byUser.values()].sort((a, b) => a.userid - b.userid);
    network.value = netData;
    services.value = svcData;
    datetime.value = dtData;
    // 表单只在未编辑时同步，避免把用户正在输入的内容覆盖掉
    if (!dtDirty.value) {
      dtForm.value = {
        timezone: dtData.timezone ?? '',
        ntp_auto_date: dtData.ntp_auto_date ?? 0,
        primary_ntp: dtData.primary_ntp ?? '',
        secondary_ntp: dtData.secondary_ntp ?? '',
      };
    }
  } catch {
    /* 401 由 api 层处理 */
  } finally {
    tableLoading.value = false;
  }
}

onMounted(() => {
  refresh();
  timer = setInterval(refresh, 15000);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <n-space vertical size="large">
    <n-alert type="default" size="small">
      本页只放**可写**的配置（用户 / 网络 / 日期时间 / 服务）。只读的系统信息——固件组件、型号与序列号、BIOS、FRU——在「系统清单」页。
    </n-alert>

    <n-card title="设置" size="small">
      <n-tabs type="line" animated :tabs-padding="isMobile ? 10 : 16">
        <n-tab-pane name="users" :tab="isMobile ? '用户' : '用户管理'">
          <n-alert type="default" size="small" style="margin-bottom: 8px">
            下表是 **web / KVM 通道**的账号（BMC 另有一套 IPMI 通道的权限，不在本页展示）。
            ID 是固定槽位：1=anonymous、2=admin，其余为空槽，新建即占用空槽。
          </n-alert>
          <n-space vertical size="small">
            <div>
              <n-button size="small" type="primary" @click="openUserCreate">新建用户</n-button>
            </div>
            <n-data-table
              :loading="tableLoading"
              :columns="userColumns"
              :data="users"
              size="small"
              :bordered="false"
              :scroll-x="isMobile ? 780 : undefined"
            />
            <p class="tip">改密码时留空表示不改；BMC 要求密码至少 8 位。</p>
          </n-space>
        </n-tab-pane>

        <n-tab-pane name="network" tab="网络">
          <!-- 窄屏：表格列多且 IPv6 是长字符串，改用逐项列表避免被挤压 -->
          <template v-if="isMobile">
            <n-descriptions
              v-for="n in network"
              :key="n.id"
              :title="n.interface_name"
              bordered
              :column="1"
              size="small"
              style="margin-bottom: 12px"
            >
              <n-descriptions-item label="MAC">{{ n.mac_address }}</n-descriptions-item>
              <n-descriptions-item label="IPv4">
                {{ n.ipv4_address }}<template v-if="n.ipv4_subnet"> / {{ n.ipv4_subnet }}</template>
              </n-descriptions-item>
              <n-descriptions-item label="地址获取">{{ n.ipv4_dhcp_enable ? 'DHCP' : '静态' }}</n-descriptions-item>
              <n-descriptions-item label="网关">{{ n.ipv4_gateway || '—' }}</n-descriptions-item>
              <n-descriptions-item label="IPv6">
                <span style="word-break: break-all">{{ n.ipv6_address || '—' }}</span>
              </n-descriptions-item>
            </n-descriptions>
          </template>
          <n-data-table v-else :columns="netColumns" :data="network" size="small" :bordered="false" />
        </n-tab-pane>

        <n-tab-pane name="datetime" :tab="isMobile ? '时间' : '日期时间'">
          <n-form label-placement="left" :label-width="90" size="small" style="max-width: 560px">
            <n-form-item label="当前时间">
              <n-space align="center" size="small">
                <n-tag size="small" :bordered="false">{{ dtNowText }}</n-tag>
                <n-tag size="small" :type="ntpState.type" :bordered="false">NTP {{ ntpState.text }}</n-tag>
              </n-space>
            </n-form-item>
            <n-form-item label="时区">
              <n-select
                v-model:value="dtForm.timezone"
                :options="tzOptions"
                filterable
                placeholder="搜索时区，如 Shanghai"
                @update:value="dtDirty = true"
              />
            </n-form-item>
            <n-form-item label="自动 NTP">
              <n-switch
                :value="dtForm.ntp_auto_date === 1"
                @update:value="(v: boolean) => { dtForm.ntp_auto_date = v ? 1 : 0; dtDirty = true; }"
              />
            </n-form-item>
            <n-form-item label="主 NTP">
              <n-select
                v-model:value="dtForm.primary_ntp"
                :options="NTP_PRESETS"
                filterable
                tag
                placeholder="填 IP，如 203.107.6.88"
                :disabled="dtForm.ntp_auto_date !== 1"
                @update:value="dtDirty = true"
              />
            </n-form-item>
            <n-form-item label="备 NTP">
              <n-select
                v-model:value="dtForm.secondary_ntp"
                :options="NTP_PRESETS"
                filterable
                tag
                placeholder="填 IP（可留空）"
                :disabled="dtForm.ntp_auto_date !== 1"
                @update:value="dtDirty = true"
              />
            </n-form-item>
            <n-form-item label=" ">
              <n-space>
                <n-button size="small" type="primary" :loading="saving" @click="saveDateTime">保存</n-button>
                <n-button size="small" quaternary @click="resetDateTime">放弃修改</n-button>
              </n-space>
            </n-form-item>
          </n-form>
          <n-alert v-if="datetime?.ntp_auto_date === 2" type="warning" size="small" style="margin-top: 8px">
            BMC 报告「NTP 服务器无效」：它无法解析主机名（本机没配 DNS），请把服务器改成 <b>IP 地址</b>——
            实测 <code>203.107.6.88</code> 与 <code>120.25.115.20</code> 可用。填域名会让整条写入失败。
          </n-alert>
          <p class="tip">
            时区与 NTP 写入已实机验证（含 UTC 偏移量，BMC 自己不会算）。NTP 生效后 BMC 时钟会同步到正确时间，
            SEL 与审计日志的时间戳随之变准；未启用 NTP 时时钟会一直停在旧时间。
          </p>
        </n-tab-pane>

        <n-tab-pane name="services" tab="服务">
          <n-space vertical size="small">
            <n-popconfirm @positive-click="clearBmcSessions">
              <template #trigger>
                <n-button size="small" :loading="clearing">清理僵尸会话</n-button>
              </template>
              将删除 BMC 上除本代理以外的全部会话记录（不改任何配置）。
              若浏览器里还开着别的 BMC 页面会被登出，确认执行？
            </n-popconfirm>
            <n-data-table :loading="tableLoading" :columns="serviceColumns" :data="services" size="small" :bordered="false" :scroll-x="isMobile ? 520 : undefined" />
          </n-space>
          <p class="tip">
            「会话 当前」取的是 BMC 真实会话列表的条数。BMC 自身 API 里的
            <code>active_session</code> 计数器实测是错的（重置后仍显示接近上限），故不使用。
          </p>
        </n-tab-pane>
      </n-tabs>

      <!-- 用户编辑 / 新建 -->
      <n-modal
        v-model:show="userDialog"
        preset="card"
        :title="userIsNew ? '新建用户' : '编辑用户 ' + userForm.name"
        style="max-width: 460px"
      >
        <n-form label-placement="left" :label-width="72" size="small">
          <n-form-item label="用户名">
            <n-input v-model:value="userForm.name" :disabled="!userIsNew" />
          </n-form-item>
          <n-form-item :label="userIsNew ? '密码' : '改密码'">
            <n-input
              v-model:value="userForm.password"
              type="password"
              show-password-on="click"
              :placeholder="userIsNew ? '至少 8 位' : '留空表示不修改'"
            />
          </n-form-item>
          <n-form-item label="权限">
            <n-select
              v-model:value="userForm.privilege"
              :options="[
                { label: 'administrator', value: 'administrator' },
                { label: 'operator', value: 'operator' },
                { label: 'user', value: 'user' },
                { label: 'none', value: 'none' },
              ]"
            />
          </n-form-item>
          <n-form-item label="KVM">
            <n-switch :value="userForm.kvm === 1" @update:value="(v: boolean) => (userForm.kvm = v ? 1 : 0)" />
          </n-form-item>
          <n-form-item label="虚拟媒体">
            <n-switch :value="userForm.vmedia === 1" @update:value="(v: boolean) => (userForm.vmedia = v ? 1 : 0)" />
          </n-form-item>
        </n-form>
        <template #footer>
          <n-space justify="end">
            <n-button size="small" quaternary @click="userDialog = false">取消</n-button>
            <n-button size="small" type="primary" :loading="saving" @click="saveUser">保存</n-button>
          </n-space>
        </template>
      </n-modal>

      <!-- 服务编辑 -->
      <n-modal
        v-model:show="serviceDialog"
        preset="card"
        :title="'编辑服务 ' + serviceForm.service_name"
        style="max-width: 460px"
      >
        <n-form label-placement="left" :label-width="90" size="small">
          <n-form-item label="启用">
            <n-switch :value="serviceForm.state === 1" @update:value="(v: boolean) => (serviceForm.state = v ? 1 : 0)" />
          </n-form-item>
          <n-form-item label="空闲超时">
            <n-input-number v-model:value="serviceForm.time_out" :min="-1" :max="65535" style="width: 150px" />
            <span class="tip" style="margin-left: 8px">秒</span>
          </n-form-item>
          <n-form-item label="会话上限">
            <n-input-number v-model:value="serviceForm.maximum_sessions" :min="1" :max="255" style="width: 150px" />
          </n-form-item>
        </n-form>
        <n-alert v-if="serviceForm.service_name === 'web'" type="warning" size="small" style="margin-top: 8px">
          改动 web 服务的端口/超时需要重连 BMC；会话上限调得太小会把自己拒之门外。
        </n-alert>
        <n-alert type="warning" size="small" style="margin-top: 8px">
          ⚠️ 实机未验证：本机 BMC 对服务配置写入返回 500（错误码 1198/1199），
          疑似需要「扩展权限」或更完整的字段集。保存失败时 BMC 配置不会改变。
        </n-alert>
        <template #footer>
          <n-space justify="end">
            <n-button size="small" quaternary @click="serviceDialog = false">取消</n-button>
            <n-button size="small" type="primary" :loading="saving" @click="saveService">保存</n-button>
          </n-space>
        </template>
      </n-modal>

      <!-- 网络编辑（高危） -->
      <n-modal
        v-model:show="netDialog"
        preset="card"
        :title="'编辑网络 ' + netForm.interface_name"
        style="max-width: 480px"
      >
        <n-alert type="error" size="small" style="margin-bottom: 12px">
          ⚠️ 网络设置写错会直接失去 BMC 访问，只能到机器前用 IPMI / 串口救回。改地址前请确认新地址可用。
        </n-alert>
        <n-form label-placement="left" :label-width="90" size="small">
          <n-form-item label="DHCP">
            <n-switch
              :value="netForm.ipv4_dhcp_enable === 1"
              @update:value="(v: boolean) => (netForm.ipv4_dhcp_enable = v ? 1 : 0)"
            />
          </n-form-item>
          <n-form-item label="IPv4 地址">
            <n-input v-model:value="netForm.ipv4_address" :disabled="netForm.ipv4_dhcp_enable === 1" />
          </n-form-item>
          <n-form-item label="掩码">
            <n-input v-model:value="netForm.ipv4_subnet" :disabled="netForm.ipv4_dhcp_enable === 1" />
          </n-form-item>
          <n-form-item label="网关">
            <n-input v-model:value="netForm.ipv4_gateway" :disabled="netForm.ipv4_dhcp_enable === 1" />
          </n-form-item>
        </n-form>
        <template #footer>
          <n-space justify="end">
            <n-button size="small" quaternary @click="netDialog = false">取消</n-button>
            <n-popconfirm @positive-click="saveNet">
              <template #trigger>
                <n-button size="small" type="error" :loading="saving">确认写入</n-button>
              </template>
              确认写入网络配置？写错会导致 BMC 失联。
            </n-popconfirm>
          </n-space>
        </template>
      </n-modal>
    </n-card>
  </n-space>
</template>

<style scoped>
.tip {
  color: #777;
  font-size: 12px;
  margin-top: 10px;
}
</style>
