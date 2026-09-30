<script setup lang="ts">
// 传感器页（重写版）：直接用归一化模型，按类别分组 + 健康过滤 + 阈值展示。
// 关键改进：不再把"未安装的传感器读数为 0"当成严重告警（判定规则见服务端 models.ts 的 healthOf）。
import { computed, h, ref } from 'vue';
import { useRouter } from 'vue-router';
import { NAlert, NButton, NCard, NDataTable, NSelect, NSpace, NSwitch, NTag } from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import { apiGet } from '../api/client';
import { useResource } from '../api/useResource';
import type { Sensor, SensorKind, SensorSnapshot } from '../api/models';
import SourceBadge from '../components/SourceBadge.vue';

const router = useRouter();
const sensors = useResource<SensorSnapshot>('/api/sensors', apiGet, { intervalMs: 10_000 });
const onlyProblems = ref(false);
const kindFilter = ref<SensorKind | 'all'>('all');

const kindLabel: Record<SensorKind, string> = {
  temperature: '温度',
  voltage: '电压',
  fan: '风扇',
  power: '电源',
  status: '状态量',
  other: '其它',
};

const healthMeta: Record<Sensor['health'], { type: 'success' | 'warning' | 'error' | 'default'; text: string }> = {
  ok: { type: 'success', text: '正常' },
  warn: { type: 'warning', text: '告警' },
  crit: { type: 'error', text: '严重' },
  na: { type: 'default', text: '不适用' },
};

const kindOptions = computed(() => {
  const present = new Set((sensors.data.value?.sensors ?? []).map((s) => s.kind));
  return [{ label: '全部类别', value: 'all' as const }, ...[...present].map((k) => ({ label: kindLabel[k], value: k }))];
});

const rows = computed(() => {
  let list = sensors.data.value?.sensors ?? [];
  if (kindFilter.value !== 'all') list = list.filter((s) => s.kind === kindFilter.value);
  if (onlyProblems.value) list = list.filter((s) => s.health === 'warn' || s.health === 'crit');
  return list;
});

function unitText(unit: string): string {
  if (unit === 'deg_c') return ' °C';
  if (unit === 'rpm') return ' RPM';
  if (unit === 'volts') return ' V';
  if (unit === 'unknown' || !unit) return '';
  return ' ' + unit;
}

function thresholdText(s: Sensor): string {
  const t = s.thresholds;
  const parts: string[] = [];
  if (t.lnc !== undefined) parts.push(`低告警 ${t.lnc}`);
  if (t.lc !== undefined) parts.push(`低严重 ${t.lc}`);
  if (t.hnc !== undefined) parts.push(`高告警 ${t.hnc}`);
  if (t.hc !== undefined) parts.push(`高严重 ${t.hc}`);
  return parts.join(' · ') || '—';
}

const columns: DataTableColumns<Sensor> = [
  { title: '名称', key: 'name', width: 156, fixed: 'left' },
  { title: '类别', key: 'kind', width: 92, render: (r) => kindLabel[r.kind] + (r.redfish ? ' ★' : '') },
  {
    title: '读数',
    key: 'value',
    width: 108,
    render: (r) => (r.value === null ? h('span', { style: 'color:#888' }, '—') : h('span', {}, `${r.value}${unitText(r.unit)}`)),
  },
  {
    title: '状态',
    key: 'health',
    width: 88,
    render: (r) =>
      h(NTag, { type: healthMeta[r.health].type, size: 'small', bordered: false }, { default: () => healthMeta[r.health].text }),
  },
  { title: '阈值', key: 'thr', render: (r) => thresholdText(r) },
  {
    title: '',
    key: 'action',
    width: 92,
    render: (r) =>
      h(
        NButton,
        { size: 'tiny', quaternary: true, onClick: () => router.push({ path: '/history', query: { sensor: r.name } }) },
        { default: () => '看趋势' },
      ),
  },
];

const counts = computed(() => sensors.data.value?.counts);
const rowKey = (r: Sensor) => r.id;
</script>

<template>
  <n-space vertical size="medium">
    <n-space justify="space-between" align="center">
      <n-space align="center" size="small">
        <n-select v-model:value="kindFilter" :options="kindOptions" size="small" style="width: 124px" />
        <n-space align="center" size="small">
          <n-switch v-model:value="onlyProblems" size="small" />
          <span style="font-size: 13px">只看异常</span>
        </n-space>
        <n-tag v-if="counts" key="total" size="small" :bordered="false">共 {{ counts.total }}</n-tag>
        <n-tag v-if="counts" key="warn" size="small" type="warning" :bordered="false">告警 {{ counts.warn }}</n-tag>
        <n-tag v-if="counts" key="crit" size="small" type="error" :bordered="false">严重 {{ counts.crit }}</n-tag>
        <n-tag v-if="counts" key="na" size="small" :bordered="false">不适用 {{ counts.na }}</n-tag>
      </n-space>
      <source-badge
        :augment="sensors.data.value?.sources.augment"
        :stale="sensors.stale.value"
        :age-sec="sensors.ageSec.value"
        :error="sensors.error.value"
      />
    </n-space>

    <n-alert v-if="sensors.data.value?.sources.redfishThermal" type="info" size="small">
      带 ★ 的传感器阈值来自 Redfish Thermal（代理后台预热获得），其余来自 BMC 主接口。
    </n-alert>
    <n-alert v-if="sensors.error.value && !sensors.data.value" type="error" size="small">
      读取失败：{{ sensors.error.value }}
    </n-alert>

    <n-card size="small">
      <n-data-table
        :columns="columns"
        :data="rows"
        :loading="sensors.loading.value && !sensors.data.value"
        :row-key="rowKey"
        :pagination="{ pageSize: 20 }"
        size="small"
        :scroll-x="760"
      />
    </n-card>
  </n-space>
</template>
