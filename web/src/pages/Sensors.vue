<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref } from 'vue';
import { NDataTable, NSelect, NTag, NCard } from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import { bmcGet } from '../api';
import type { Sensor } from '../types';
import { useIsMobile } from '../useMediaQuery';

const isMobile = useIsMobile();

const sensors = ref<Sensor[]>([]);
const filterType = ref<string>('all');
let timer: ReturnType<typeof setInterval> | null = null;

const typeOptions = computed(() => {
  const set = new Map<string, string>();
  for (const s of sensors.value) {
    if (!set.has(s.unit)) set.set(s.unit, unitLabel(s.unit));
  }
  return [{ label: '全部', value: 'all' }, ...[...set.entries()].map(([v, l]) => ({ label: l, value: v }))];
});

function unitLabel(unit: string): string {
  const map: Record<string, string> = {
    deg_c: '温度 (°C)',
    rpm: '风扇 (RPM)',
    volts: '电压 (V)',
    amps: '电流 (A)',
    watts: '功耗 (W)',
    percent: '百分比 (%)',
    unknown: '其他',
  };
  return map[unit.toLowerCase()] ?? unit;
}

function stateTag(s: Sensor) {
  // sensor_state: 1 = normal（经验值）；阈值越界时原版显示告警
  const abnormal =
    s.sensor_state !== 1 &&
    s.name !== 'PSU_STATUS' && // ATX 电源误报已知
    !s.name.startsWith('PSU');
  return abnormal
    ? { label: '异常', type: 'warning' as const }
    : { label: '正常', type: 'success' as const };
}

function thresholdText(v: number | 'NA'): string {
  return v === 'NA' ? '—' : String(v);
}

const UNIT_SHORT: Record<string, string> = { deg_c: '°C', rpm: 'RPM', volts: 'V', amps: 'A', watts: 'W', percent: '%' };

function unitShort(unit: string): string {
  return UNIT_SHORT[unit.toLowerCase()] ?? unit;
}

const thresholdColumns: DataTableColumns<Sensor> = [
  { title: '下限(不可恢复)', key: 'lnr', width: 130, render: (s) => thresholdText(s.lower_non_recoverable_threshold) },
  { title: '下限(严重)', key: 'lcr', width: 110, render: (s) => thresholdText(s.lower_critical_threshold) },
  { title: '下限(非严重)', key: 'lnc', width: 120, render: (s) => thresholdText(s.lower_non_critical_threshold) },
  { title: '上限(非严重)', key: 'hnc', width: 120, render: (s) => thresholdText(s.higher_non_critical_threshold) },
  { title: '上限(严重)', key: 'hcr', width: 110, render: (s) => thresholdText(s.higher_critical_threshold) },
  { title: '上限(不可恢复)', key: 'hnr', width: 130, render: (s) => thresholdText(s.higher_non_recoverable_threshold) },
];

// 窄屏只保留核心列（阈值列在手机上横滑体验差），桌面端展示全部列
const columns = computed<DataTableColumns<Sensor>>(() => [
  { title: 'ID', key: 'sensor_number', width: isMobile.value ? 46 : 60 },
  { title: '名称', key: 'name', width: isMobile.value ? 128 : 180 },
  {
    title: '读数',
    key: 'reading',
    width: isMobile.value ? 88 : 110,
    render: (s) => `${s.reading} ${unitShort(s.unit)}`,
  },
  { title: '状态', key: 'state', width: isMobile.value ? 66 : 80, render: (s) => { const t = stateTag(s); return h(NTag, { size: 'small', type: t.type }, { default: () => t.label }); } },
  ...(isMobile.value ? [] : thresholdColumns),
]);

const filtered = computed(() =>
  filterType.value === 'all' ? sensors.value : sensors.value.filter((s) => s.unit === filterType.value),
);

async function refresh() {
  try {
    sensors.value = await bmcGet<Sensor[]>('sensors');
  } catch {
    /* 401 已由 api 层处理 */
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
  <n-card title="传感器">
    <template #header-extra>
      <n-select v-model:value="filterType" :options="typeOptions" style="width: 160px" size="small" />
    </template>
    <n-data-table
      :columns="columns"
      :data="filtered"
      :bordered="false"
      size="small"
      :pagination="false"
      :scroll-x="isMobile ? 328 : undefined"
    />
  </n-card>
</template>
