<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref } from 'vue';
import { NCard, NDataTable, NTag } from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import { bmcGet } from '../api';
import type { SelEvent } from '../types';
import { useIsMobile } from '../useMediaQuery';

const isMobile = useIsMobile();

const events = ref<SelEvent[]>([]);
const loading = ref(true);
let timer: ReturnType<typeof setInterval> | null = null;

// ⚠️ SEL 时间戳疑似来自主机 RTC（真实日期），而 BMC 自身时钟停在 2024-01-01（NTP 禁用），
// 两者存在偏差，展示原始换算结果即可。
function fmtTime(ts: number): string {
  if (!ts) return '—';
  const ms = ts < 10_000_000_000 ? ts * 1000 : ts;
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
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
    loading.value = false;
  } catch {
    loading.value = false;
  }
}

onMounted(() => {
  refresh();
  timer = setInterval(refresh, 10000);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <n-card title="IPMI 事件日志 (SEL)">
    <template #header-extra>
      <span v-if="!isMobile" class="dim">共 {{ events.length }} 条 · 10s 自动刷新 · SEL 已满（1022 条上限）</span>
    </template>
    <p v-if="isMobile" class="dim" style="margin: 0 0 10px">
      共 {{ events.length }} 条 · 10s 自动刷新 · SEL 已满（1022 条上限）
    </p>
    <n-data-table
      :columns="columns"
      :data="events"
      :loading="loading"
      size="small"
      :pagination="{ pageSize: isMobile ? 20 : 50 }"
      :bordered="false"
      :scroll-x="isMobile ? 620 : undefined"
    />
  </n-card>
</template>

<style scoped>
.dim {
  color: #777;
  font-size: 12px;
}
</style>
