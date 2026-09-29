<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref } from 'vue';
import { NButton, NCard, NDataTable, NInput, NSelect, NSpace, NTag } from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import { bmcGet } from '../api';
import type { SelEvent } from '../types';
import { useIsMobile } from '../useMediaQuery';

const isMobile = useIsMobile();

const events = ref<SelEvent[]>([]);
const loading = ref(true);
const pageSize = ref<number>(isMobile.value ? 20 : 50);

// ---------- 筛选条件 ----------
const keyword = ref('');
const sensorFilter = ref<string | null>(null);
const directionFilter = ref<number | null>(null);

let timer: ReturnType<typeof setInterval> | null = null;

// ⚠️ SEL 时间戳疑似来自主机 RTC（真实日期），而 BMC 自身时钟停在 2024-01-01（NTP 禁用），
// 两者存在偏差，展示原始换算结果即可。
function fmtTime(ts: number): string {
  if (!ts) return '—';
  const ms = ts < 10_000_000_000 ? ts * 1000 : ts;
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

/** 传感器下拉项（按出现频次排序） */
const sensorOptions = computed(() => {
  const count = new Map<string, number>();
  for (const e of events.value) {
    const name = e.sensor_name || '(无)';
    count.set(name, (count.get(name) ?? 0) + 1);
  }
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => ({ label: `${name}（${n}）`, value: name }));
});

const directionOptions = [
  { label: '全部方向', value: null as number | null },
  { label: 'Assert（触发）', value: 0 },
  { label: 'Deassert（恢复）', value: 1 },
];

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  return events.value.filter((e) => {
    if (sensorFilter.value !== null && (e.sensor_name || '(无)') !== sensorFilter.value) return false;
    if (directionFilter.value !== null && e.event_direction !== directionFilter.value) return false;
    if (kw) {
      const hay = `${e.sensor_name ?? ''} ${e.description ?? ''} ${e.id}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });
});

const hasFilter = computed(
  () => keyword.value.trim() !== '' || sensorFilter.value !== null || directionFilter.value !== null,
);

function resetFilter() {
  keyword.value = '';
  sensorFilter.value = null;
  directionFilter.value = null;
}

const columns = computed<DataTableColumns<SelEvent>>(() => [
  { title: 'ID', key: 'id', width: 70, sorter: (a, b) => b.id - a.id },
  { title: '时间', key: 'timestamp', width: isMobile.value ? 140 : 180, render: (e) => fmtTime(e.timestamp) },
  { title: '传感器', key: 'sensor_name', width: isMobile.value ? 130 : 200 },
  {
    title: '方向',
    key: 'event_direction',
    width: 90,
    render: (e) => {
      if (e.event_direction === undefined) return '—';
      return e.event_direction === 0
        ? h(NTag, { size: 'small', type: 'warning' }, { default: () => 'Assert' })
        : h(NTag, { size: 'small', type: 'success' }, { default: () => 'Deassert' });
    },
  },
  { title: '描述', key: 'description', ellipsis: { tooltip: true } },
]);

async function refresh() {
  try {
    const data = await bmcGet<SelEvent[]>('logs/event');
    if (Array.isArray(data)) events.value = data;
  } catch {
    /* 401 已由 api 层处理 */
  } finally {
    loading.value = false;
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
  <n-card title="IPMI 事件日志 (SEL)">
    <template #header-extra>
      <span v-if="!isMobile" class="dim">
        共 {{ events.length }} 条<template v-if="hasFilter">（筛选出 {{ filtered.length }} 条）</template>
        · 15s 自动刷新
      </span>
    </template>

    <n-space vertical size="small">
      <n-space :size="8" :wrap="true" align="center">
        <n-input
          v-model:value="keyword"
          size="small"
          clearable
          placeholder="搜索传感器 / 描述 / ID"
          style="width: 220px"
        />
        <n-select
          v-model:value="sensorFilter"
          size="small"
          clearable
          placeholder="按传感器"
          style="width: 200px"
          :options="sensorOptions"
        />
        <n-select
          v-model:value="directionFilter"
          size="small"
          style="width: 170px"
          :options="directionOptions"
        />
        <n-select
          v-model:value="pageSize"
          size="small"
          style="width: 120px"
          :options="[
            { label: '每页 20', value: 20 },
            { label: '每页 50', value: 50 },
            { label: '每页 100', value: 100 },
            { label: '每页 200', value: 200 },
          ]"
        />
        <n-button v-if="hasFilter" size="small" quaternary @click="resetFilter">清除筛选</n-button>
      </n-space>
      <span v-if="isMobile" class="dim">共 {{ events.length }} 条，筛选出 {{ filtered.length }} 条</span>

      <n-data-table
        :columns="columns"
        :data="filtered"
        :loading="loading"
        size="small"
        :pagination="{ pageSize }"
        :bordered="false"
        :scroll-x="isMobile ? 620 : undefined"
      />
    </n-space>
  </n-card>
</template>

<style scoped>
.dim {
  color: #777;
  font-size: 12px;
}
</style>
