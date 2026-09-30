<script setup lang="ts">
// 系统清单页（新增）。
//
// 这一页正是「Redfish 增补」的价值所在：FRU、账户、网络来自 BMC 主接口，
// 而 **BIOS 版本、可更新标记、固件组件清单** 只有 Redfish 有。
// 服务端把两者合并在 /api/inventory 里，并明确标出每个固件项的来源。
import { computed, h } from 'vue';
import { NAlert, NCard, NDataTable, NDescriptions, NDescriptionsItem, NGi, NGrid, NSpace, NTag } from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import { apiGet } from '../api/client';
import { useResource } from '../api/useResource';
import type { Inventory } from '../api/models';
import SourceBadge from '../components/SourceBadge.vue';

const inv = useResource<Inventory>('/api/inventory', apiGet, { intervalMs: 60_000 });
const data = computed(() => inv.data.value);

const fwColumns: DataTableColumns<Inventory['firmware'][number]> = [
  { title: '组件', key: 'name', width: 140 },
  { title: '版本', key: 'version', width: 140 },
  {
    title: '可更新',
    key: 'updateable',
    width: 90,
    render: (r) => (r.updateable === null ? '—' : r.updateable ? '是' : '否'),
  },
  {
    title: '来源',
    key: 'source',
    width: 100,
    render: (r) =>
      h(
        NTag,
        { size: 'small', bordered: false, type: r.source === 'redfish' ? 'success' : 'default' },
        { default: () => (r.source === 'redfish' ? 'Redfish' : 'BMC 主接口') },
      ),
  },
];

const accColumns: DataTableColumns<Inventory['accounts'][number]> = [
  { title: '用户名', key: 'name', width: 140 },
  { title: '权限', key: 'privilege', width: 130 },
  { title: '启用', key: 'enabled', width: 80, render: (r) => (r.enabled ? '是' : '否') },
  { title: '通道', key: 'channel' },
];

// 模板里不能写 TS 类型注解，所以把 :row-key 用到的取值函数定义在这里
const fwRowKey = (r: Inventory['firmware'][number]) => r.name;
const accRowKey = (r: Inventory['accounts'][number]) => r.name;

/** 只显示有内容的 FRU（这台机器上不少槽位是空的） */
const frus = computed(() => (data.value?.fru ?? []).filter((f) => f.product.product || f.board.product || f.board.serial));
</script>

<template>
  <n-space vertical size="medium">
    <n-space justify="space-between" align="center">
      <n-tag key="counts" size="small" :bordered="false">FRU {{ data?.fru.length ?? 0 }} 个 · 账户 {{ data?.accounts.length ?? 0 }} 个</n-tag>
      <source-badge
        :augment="data?.sources.augment"
        :stale="inv.stale.value"
        :age-sec="inv.ageSec.value"
        :error="inv.error.value"
      />
    </n-space>

    <n-alert v-if="inv.error.value && !data" key="err" type="error" size="small">读取失败：{{ inv.error.value }}</n-alert>
    <n-alert v-else-if="data && !data.sources.redfish" key="aug" type="info" size="small">
      Redfish 增补尚未就绪（后台预热中或该资源不可用），固件清单暂时只有 BMC 主接口能提供的部分。
      {{ data.sources.redfishReason }}
    </n-alert>

    <n-grid :x-gap="12" :y-gap="12" cols="1 m:2" responsive="screen">
      <n-gi>
        <n-card size="small" title="固件组件">
          <n-data-table :columns="fwColumns" :data="data?.firmware ?? []" size="small" :row-key="fwRowKey" />
          <n-alert type="warning" size="small" style="margin-top: 10px">
            固件刷写请用带外流程（详见仓库 docs/API.md 第 10 节）：本机实测网页面板/Redfish SimpleUpdate 都走不通，
            可用的是让 BMC 从 TFTP 拉取（<code>reverse/tftp_server.py</code> + <code>reverse/flash_via_tftp_full.mjs</code>）。
          </n-alert>
        </n-card>
      </n-gi>
      <n-gi>
        <n-card size="small" title="网络">
          <n-descriptions v-if="data?.network" :column="1" size="small" bordered>
            <n-descriptions-item label="接口">{{ data.network.interface }}</n-descriptions-item>
            <n-descriptions-item label="MAC">{{ data.network.mac }}</n-descriptions-item>
            <n-descriptions-item label="IPv4">
              {{ data.network.ipv4 }} / {{ data.network.subnet }}（{{ data.network.dhcp ? 'DHCP' : '静态' }}）
            </n-descriptions-item>
            <n-descriptions-item label="网关">{{ data.network.gateway }}</n-descriptions-item>
            <n-descriptions-item label="IPv6">{{ data.network.ipv6 || '—' }}</n-descriptions-item>
          </n-descriptions>
          <n-alert v-else type="default" size="small">网络信息不可用</n-alert>
        </n-card>
      </n-gi>
    </n-grid>

    <n-card size="small" title="FRU（板卡与产品信息）">
      <n-space vertical size="small">
        <n-descriptions v-for="f in frus" :key="f.id" :column="2" size="small" bordered :title="`${f.name}（${f.type || '未标类型'}）`">
          <n-descriptions-item label="厂商">{{ f.board.manufacturer || f.product.manufacturer || '—' }}</n-descriptions-item>
          <n-descriptions-item label="产品">{{ f.board.product || f.product.product || '—' }}</n-descriptions-item>
          <n-descriptions-item label="序列号">{{ f.board.serial || f.product.serial || '—' }}</n-descriptions-item>
          <n-descriptions-item label="料号">{{ f.board.part || f.product.part || '—' }}</n-descriptions-item>
        </n-descriptions>
        <n-alert v-if="!frus.length" type="default" size="small">没有可显示的 FRU</n-alert>
      </n-space>
    </n-card>

    <n-card size="small" title="BMC 账户">
      <n-data-table :columns="accColumns" :data="data?.accounts ?? []" size="small" :row-key="fwRowKey" :pagination="{ pageSize: 10 }" />
    </n-card>
  </n-space>
</template>
