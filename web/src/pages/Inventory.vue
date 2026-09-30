<script setup lang="ts">
// 系统清单页（只读）。
//
// 与「设置」页的分工（此前两边都放 FRU/用户/网络，用户反馈重复）：
//   · 本页只放**看**的东西：系统身份（型号/序列号/BIOS/CPU/内存/健康）、固件组件清单、FRU；
//   · 可写的东西（用户、网络、日期时间、服务）一律在「设置」页。
//
// 固件组件清单是本页最独特的内容：**只有 Redfish 提供**（含"可更新"标记），
// 由代理后台预热，拿不到时退回经典接口并如实标注降级。
import { computed, h } from 'vue';
import { NAlert, NCard, NDataTable, NDescriptions, NDescriptionsItem, NGi, NGrid, NSpace, NTag } from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import { apiGet } from '../api/client';
import { useResource } from '../api/useResource';
import type { Inventory } from '../api/models';
import SourceBadge from '../components/SourceBadge.vue';

const inv = useResource<Inventory>('/api/inventory', apiGet, { intervalMs: 60_000 });
const data = computed(() => inv.data.value);
const sys = computed(() => data.value?.system);

const fwColumns: DataTableColumns<Inventory['firmware'][number]> = [
  { title: '组件', key: 'name', width: 120 },
  { title: '版本', key: 'version', width: 120 },
  {
    title: '可更新',
    key: 'updateable',
    width: 88,
    render: (r) =>
      r.updateable === null
        ? '—'
        : h(NTag, { size: 'small', bordered: false, type: r.updateable ? 'success' : 'default' }, { default: () => (r.updateable ? '是' : '否') }),
  },
  {
    title: '来源',
    key: 'source',
    render: (r) =>
      h(
        NTag,
        { size: 'small', bordered: false, type: r.source === 'redfish' ? 'success' : 'default' },
        { default: () => (r.source === 'redfish' ? 'Redfish' : 'BMC 主接口') },
      ),
  },
];

const fwRowKey = (r: Inventory['firmware'][number]) => r.name;

/** 增补是否已就绪（就绪后仍空的字段说明该 BMC 本来就没提供，显示 — 更诚实） */
const augmented = computed(() => !!data.value?.sources.augment.available);
const fill = (v: string | undefined) => v || (augmented.value ? '—' : '待增补');

/** 只显示有内容的 FRU（这台机器上不少槽位是空的） */
const frus = computed(() => (data.value?.fru ?? []).filter((f) => f.product.product || f.board.product || f.board.serial));

/** 固件清单这块的状态说明（只在这块没就绪时展示；别用笼统的"增补尚未就绪"） */
const firmwareHint = computed(() => {
  const a = data.value?.sources.augment;
  if (!a) return '后台预热中';
  if (a.parts.firmware) return '已就绪';
  return a.lastError ? `上次失败：${a.lastError}` : '后台预热中（首次取用约需几十秒）';
});
</script>

<template>
  <div class="inv-page">
    <n-space justify="space-between" align="center">
      <n-space align="center" size="small">
        <n-tag key="power" :type="sys?.powerState === 'on' ? 'success' : 'default'" :bordered="false" size="small">
          主机{{ sys?.powerState === 'on' ? '在线' : '离线' }}
        </n-tag>
        <n-tag v-if="sys?.health" key="health" :type="sys.health.toLowerCase() === 'ok' ? 'success' : 'warning'" :bordered="false" size="small">
          健康：{{ sys.health }}
        </n-tag>
        <n-tag key="fru" size="small" :bordered="false">FRU {{ data?.fru.length ?? 0 }} 个</n-tag>
      </n-space>
      <source-badge :augment="data?.sources.augment" :stale="inv.stale.value" :age-sec="inv.ageSec.value" :error="inv.error.value" />
    </n-space>

    <n-alert v-if="inv.error.value && !data" key="err" type="error" size="small">读取失败：{{ inv.error.value }}</n-alert>
    <n-alert v-else-if="data && !data.sources.redfish" key="aug" type="info" size="small">
      固件组件清单尚未从 Redfish 取到（{{ firmwareHint }}），当前只显示 BMC 主接口能提供的内容。
    </n-alert>

    <!-- 宽屏两栏：左系统身份、右固件组件；窄屏自动叠成一栏 -->
    <n-grid :x-gap="12" :y-gap="12" cols="1 l:2" responsive="screen">
      <n-gi>
        <n-card size="small" title="系统信息">
          <n-descriptions :column="1" size="small" bordered>
            <n-descriptions-item label="型号">{{ sys?.model || '—' }}</n-descriptions-item>
            <n-descriptions-item label="厂商">{{ sys?.manufacturer || '—' }}</n-descriptions-item>
            <n-descriptions-item label="序列号">{{ sys?.serial || '—' }}</n-descriptions-item>
            <n-descriptions-item label="BIOS">{{ fill(sys?.biosVersion) }}</n-descriptions-item>
            <n-descriptions-item label="CPU">{{ fill(sys?.cpuSummary) }}</n-descriptions-item>
            <n-descriptions-item label="内存">{{ fill(sys?.memorySummary) }}</n-descriptions-item>
            <n-descriptions-item label="UUID">
              <span style="font-family: monospace; font-size: 12px">{{ fill(sys?.uuid) }}</span>
            </n-descriptions-item>
          </n-descriptions>
          <n-alert type="default" size="small" style="margin-top: 10px">
            CPU / 内存 / BIOS / 序列号由 Redfish 提供（后台预热）；用户、网络等**可写**项在「设置」页。
          </n-alert>
        </n-card>
      </n-gi>
      <n-gi>
        <n-card size="small" title="固件组件">
          <n-data-table :columns="fwColumns" :data="data?.firmware ?? []" size="small" :row-key="fwRowKey" />
          <n-alert type="warning" size="small" style="margin-top: 10px">
            刷写固件请用带外流程（本机实测网页面板与 Redfish SimpleUpdate 都走不通，可用的是让 BMC 从 TFTP 拉取）：
            详见仓库 <code>docs/API.md</code> 第 10 节与 <code>reverse/flash_via_tftp_full.mjs</code>。
          </n-alert>
        </n-card>
      </n-gi>
    </n-grid>

    <n-card size="small" title="FRU（板卡与产品信息）">
      <n-grid :x-gap="12" :y-gap="12" cols="1 xl:2 2xl:3" responsive="screen">
        <n-gi v-for="f in frus" :key="f.id">
          <n-descriptions :column="1" size="small" bordered :title="`${f.name}（${f.type || '未标类型'}）`">
            <n-descriptions-item label="厂商">{{ f.board.manufacturer || f.product.manufacturer || '—' }}</n-descriptions-item>
            <n-descriptions-item label="产品">{{ f.board.product || f.product.product || '—' }}</n-descriptions-item>
            <n-descriptions-item label="序列号">{{ f.board.serial || f.product.serial || '—' }}</n-descriptions-item>
            <n-descriptions-item label="料号">{{ f.board.part || f.product.part || '—' }}</n-descriptions-item>
          </n-descriptions>
        </n-gi>
      </n-grid>
      <n-alert v-if="!frus.length" type="default" size="small">没有可显示的 FRU</n-alert>
    </n-card>
  </div>
</template>

<style scoped>
/* 超宽屏下把内容收在中线：信息类页面拉满 2560px 会很难读 */
.inv-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 1720px;
  margin: 0 auto;
}
</style>
