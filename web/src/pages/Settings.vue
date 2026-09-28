<script setup lang="ts">
import { h, onBeforeUnmount, onMounted, ref } from 'vue';
import { NTabs, NTabPane, NDataTable, NDescriptions, NDescriptionsItem, NAlert, NTag } from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import { bmcGet } from '../api';
import { WRITE_OPS_ENABLED } from '../config';

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
  { title: 'SSH 公钥', key: 'ssh_key', render: (u) => (u.ssh_key === 'Not Available' ? '—' : u.ssh_key) },
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
  { title: '会话 上限/当前', key: 'sess', render: (s) => `${s.active_session} / ${s.maximum_sessions}` },
];

async function refresh() {
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
    <n-alert v-if="!WRITE_OPS_ENABLED" type="warning" :bordered="false">
      设置页当前为<b>只读展示</b>；各设置项的写协议已在 docs/API.md 逆向归档，
      修改功能在写操作对照验证后随 WRITE_OPS_ENABLED 一并开放。
    </n-alert>

    <n-card title="设置" size="small">
      <n-tabs type="line" animated>
        <n-tab-pane name="fru" tab="FRU 信息">
          <n-descriptions
            v-for="d in fru"
            :key="d.device.id"
            :title="d.device.name"
            bordered
            :column="2"
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

        <n-tab-pane name="users" tab="用户管理">
          <n-data-table :columns="userColumns" :data="users" size="small" :bordered="false" />
        </n-tab-pane>

        <n-tab-pane name="network" tab="网络">
          <n-data-table :columns="netColumns" :data="network" size="small" :bordered="false" />
        </n-tab-pane>

        <n-tab-pane name="datetime" tab="日期时间">
          <n-descriptions bordered :column="2" size="small">
            <n-descriptions-item label="时区">{{ datetime?.timezone ?? '—' }}</n-descriptions-item>
            <n-descriptions-item label="NTP">
              <n-tag size="small" :type="datetime?.ntp_auto_date === 1 ? 'success' : 'warning'">
                {{ datetime?.ntp_auto_date === 1 ? '自动同步' : '未启用/手动' }}
              </n-tag>
            </n-descriptions-item>
            <n-descriptions-item label="主 NTP">{{ datetime?.primary_ntp ?? '—' }}</n-descriptions-item>
            <n-descriptions-item label="备 NTP">{{ datetime?.secondary_ntp ?? '—' }}</n-descriptions-item>
          </n-descriptions>
          <p class="tip">⚠️ BMC 时钟停在 2024-01-01（NTP 未启用）；SEL 时间戳与真实时间存在偏差。</p>
        </n-tab-pane>

        <n-tab-pane name="services" tab="服务">
          <n-data-table :columns="serviceColumns" :data="services" size="small" :bordered="false" />
          <p class="tip">会话"当前"数长期接近上限（BMC 会话表泄漏现象），是本代理坚持单会话复用的原因。</p>
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
