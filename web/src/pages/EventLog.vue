<script setup lang="ts">
// 事件日志（SEL）页（重写版）。
// 数据来自归一化接口 /api/sel：服务端已把 BMC 的裸字段整理成
// {时间, 严重度, 方向, 传感器, 描述}，前端只做筛选与分页。
import { computed, h, ref } from 'vue';
import { NAlert, NCard, NDataTable, NInput, NSelect, NSpace, NTag } from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import { apiGet } from '../api/client';
import { useResource } from '../api/useResource';
import type { SelEntry } from '../api/models';
import SourceBadge from '../components/SourceBadge.vue';

const sel = useResource<{ entries: SelEntry[]; total: number }>('/api/sel?limit=500', apiGet, { intervalMs: 30_000 });
const keyword = ref('');
const severity = ref<'all' | SelEntry['severity']>('all');
const direction = ref<'all' | 'asserted' | 'deasserted'>('all');

const severityMeta: Record<SelEntry['severity'], { type: 'error' | 'warning' | 'info'; text: string }> = {
  crit: { type: 'error', text: '严重' },
  warn: { type: 'warning', text: '告警' },
  info: { type: 'info', text: '信息' },
};

const directionOptions = computed(() => {
  const present = new Set((sel.data.value?.entries ?? []).map((e) => e.direction).filter(Boolean));
  return [
    { label: '全部方向', value: 'all' as const },
    ...[...present].map((d) => ({ label: d === 'asserted' ? '触发' : d === 'deasserted' ? '恢复' : d, value: d as 'asserted' | 'deasserted' })),
  ];
});

const rows = computed(() => {
  let list = sel.data.value?.entries ?? [];
  if (severity.value !== 'all') list = list.filter((e) => e.severity === severity.value);
  if (direction.value !== 'all') list = list.filter((e) => e.direction === direction.value);
  const kw = keyword.value.trim().toLowerCase();
  if (kw) list = list.filter((e) => `${e.sensor} ${e.message} ${e.sensorType}`.toLowerCase().includes(kw));
  return list;
});

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const rowKey = (r: SelEntry) => r.id;

const columns: DataTableColumns<SelEntry> = [
  { title: '时间', key: 'time', width: 168, render: (r) => fmtTime(r.time) },
  {
    title: '级别',
    key: 'severity',
    width: 82,
    render: (r) =>
      h(NTag, { type: severityMeta[r.severity].type, size: 'small', bordered: false }, { default: () => severityMeta[r.severity].text }),
  },
  { title: '方向', key: 'direction', width: 76, render: (r) => (r.direction === 'asserted' ? '触发' : r.direction === 'deasserted' ? '恢复' : r.direction) },
  { title: '传感器', key: 'sensor', width: 150 },
  { title: '描述', key: 'message', render: (r) => r.message || '—' },
];
</script>

<template>
  <n-space vertical size="medium">
    <n-space justify="space-between" align="center">
      <n-space align="center" size="small">
        <n-input v-model:value="keyword" placeholder="按描述/传感器过滤" size="small" clearable style="width: 220px" />
        <n-select
          v-model:value="severity"
          size="small"
          style="width: 108px"
          :options="[
            { label: '全部级别', value: 'all' },
            { label: '严重', value: 'crit' },
            { label: '告警', value: 'warn' },
            { label: '信息', value: 'info' },
          ]"
        />
        <n-select v-model:value="direction" size="small" style="width: 108px" :options="directionOptions" />
        <n-tag key="total" size="small" :bordered="false">共 {{ sel.data.value?.total ?? 0 }} 条</n-tag>
      </n-space>
      <source-badge :stale="sel.stale.value" :age-sec="sel.ageSec.value" :error="sel.error.value" />
    </n-space>

    <n-alert v-if="sel.error.value && !sel.data.value" type="error" size="small">读取失败：{{ sel.error.value }}</n-alert>
    <n-alert v-else key="hint" type="info" size="small">
      BMC 时间未同步 NTP 时，日志时间戳会不准（这台 BMC 的时钟停在 2012/2024），判断先后请以记录序号为准。
    </n-alert>

    <n-card size="small">
      <n-data-table
        :columns="columns"
        :data="rows"
        :loading="sel.loading.value && !sel.data.value"
        :row-key="rowKey"
        :pagination="{ pageSize: 25 }"
        size="small"
        :scroll-x="900"
      />
    </n-card>
  </n-space>
</template>
