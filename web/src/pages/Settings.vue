<script setup lang="ts">
import { h, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  NButton,
  NDataTable,
  NDescriptions,
  NDescriptionsItem,
  NPopconfirm,
  NSpace,
  NTabPane,
  NTabs,
  NTag,
  useMessage,
} from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import { bmcGet } from '../api';
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

interface FruDevice {
  device: { id: number; name: string };
  chassis?: { type: string; part_number: string; serial_number: string };
  board?: { date: string; manufacturer: string; product_name: string; serial_number: string; part_number: string };
  product?: { manufacturer: string; product_name: string; part_number: string; product_version: string; serial_number: string; asset_tag: string };
}
interface BmcUser {
  id: number;
  userid: number;
  name: string;
  access: number;
  privilege: string;
  kvm: number;
  vmedia: number;
  ssh_key: string;
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
  non_secure_port: number;
  secure_port: number;
  maximum_sessions: number;
  active_session: number;
}

const fru = ref<FruDevice[]>([]);
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
const datetime = ref<{ primary_ntp: string; secondary_ntp: string; ntp_auto_date: number; timezone: string } | null>(null);
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
    const [fruData, usersData, netData, svcData, dtData] = await Promise.all([
      bmcGet<FruDevice[]>('fru'),
      bmcGet<BmcUser[]>('settings/users'),
      bmcGet<NetIf[]>('settings/network'),
      bmcGet<BmcService[]>('settings/services'),
      bmcGet<{ primary_ntp: string; secondary_ntp: string; ntp_auto_date: number; timezone: string }>('settings/date-time'),
    ]);
    fru.value = fruData;
    users.value = usersData.filter((u) => u.privilege !== undefined);
    network.value = netData;
    services.value = svcData;
    datetime.value = dtData;
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
    <n-card title="设置" size="small">
      <n-tabs type="line" animated :tabs-padding="isMobile ? 10 : 16">
        <n-tab-pane name="fru" :tab="isMobile ? 'FRU' : 'FRU 信息'">
          <n-descriptions
            v-for="d in fru"
            :key="d.device.id"
            :title="d.device.name"
            bordered
            :column="isMobile ? 1 : 2"
            size="small"
            style="margin-bottom: 16px"
          >
            <n-descriptions-item label="机箱类型">{{ d.chassis?.type ?? '—' }}</n-descriptions-item>
            <n-descriptions-item label="机箱序列号">{{ d.chassis?.serial_number ?? '—' }}</n-descriptions-item>
            <n-descriptions-item label="板卡产品">{{ d.board?.product_name ?? '—' }}</n-descriptions-item>
            <n-descriptions-item label="板卡序列号">{{ d.board?.serial_number ?? '—' }}</n-descriptions-item>
            <n-descriptions-item label="产品名称">{{ d.product?.product_name ?? '—' }}</n-descriptions-item>
            <n-descriptions-item label="资产标签">{{ d.product?.asset_tag ?? '—' }}</n-descriptions-item>
          </n-descriptions>
        </n-tab-pane>

        <n-tab-pane name="users" :tab="isMobile ? '用户' : '用户管理'">
          <n-data-table :loading="tableLoading" :columns="userColumns" :data="users" size="small" :bordered="false" :scroll-x="isMobile ? 620 : undefined" />
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
          <n-descriptions bordered :column="isMobile ? 1 : 2" size="small">
            <n-descriptions-item label="时区">{{ datetime?.timezone ?? '—' }}</n-descriptions-item>
            <n-descriptions-item label="NTP">
              <n-tag size="small" :type="datetime?.ntp_auto_date === 1 ? 'success' : 'warning'">
                {{ datetime?.ntp_auto_date === 1 ? '自动同步' : '未启用/手动' }}
              </n-tag>
            </n-descriptions-item>
            <n-descriptions-item label="主 NTP">{{ datetime?.primary_ntp ?? '—' }}</n-descriptions-item>
            <n-descriptions-item label="备 NTP">{{ datetime?.secondary_ntp ?? '—' }}</n-descriptions-item>
          </n-descriptions>
          <p class="tip">BMC 未启用 NTP，时钟可能不准，日志时间戳会随之偏移。</p>
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
