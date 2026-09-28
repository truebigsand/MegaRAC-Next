<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { NCard, NSelect, NSpace, NSpin, NEmpty } from 'naive-ui';
import * as echarts from 'echarts';
import { localGet } from '../api';
import { useIsMobile } from '../useMediaQuery';
import { useChartAutoResize } from '../useChartAutoResize';

const isMobile = useIsMobile();

const available = ref<string[]>([]);
const picked = ref<string[]>(['CPU0_TEMP', 'CPU0_DTS', 'CPU0_FAN']);
const windowMinutes = ref<number>(60);
const loading = ref(true);
const chartEl = ref<HTMLDivElement>();
let chart: echarts.ECharts | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

const windowOptions = [
  { label: '最近 1 小时', value: 60 },
  { label: '最近 6 小时', value: 360 },
  { label: '最近 24 小时', value: 1440 },
  { label: '最近 7 天', value: 10080 },
  { label: '最近 30 天', value: 43200 },
];

// 无数据时优雅降级：采样器只在有登录会话时工作
const UNIT_HINT: Record<string, string> = { deg_c: '°C', rpm: 'RPM', volts: 'V', amps: 'A', watts: 'W', percent: '%' };

async function refresh() {
  try {
    if (available.value.length === 0) {
      const res = await localGet<{ sensors: string[] }>('/api/history/sensors');
      available.value = res.sensors;
      if (res.sensors.length === 0) {
        loading.value = false;
        return;
      }
    }
    if (picked.value.length === 0) {
      loading.value = false;
      return;
    }
    const results = await Promise.all(
      picked.value.map(async (sensor) => ({
        sensor,
        data: await localGet<{ points: { ts: number; value: number }[] }>(`/api/history?sensor=${encodeURIComponent(sensor)}&minutes=${windowMinutes.value}`),
      })),
    );
    const series = results
      .filter((r) => r.data.points.length > 0)
      .map((r) => ({
        name: r.sensor,
        type: 'line' as const,
        showSymbol: false,
        data: r.data.points.map((p) => [p.ts, p.value]),
      }));
    chart?.setOption(
      {
        animation: false,
        tooltip: { trigger: 'axis' },
        // 窄屏图例单行可翻页并预留空间，避免多行图例压住曲线
        legend: isMobile.value
          ? {
              type: 'scroll',
              top: 0,
              textStyle: { color: '#bbb', fontSize: 10 },
              itemGap: 8,
              itemWidth: 12,
              itemHeight: 8,
              pageIconSize: 10,
              pageIconColor: '#bbb',
              pageIconInactiveColor: '#555',
              pageTextStyle: { color: '#bbb' },
            }
          : { top: 0, textStyle: { color: '#aaa', fontSize: 11 } },
        grid: { left: isMobile.value ? 48 : 60, right: 20, top: isMobile.value ? 42 : 36, bottom: 40 },
        xAxis: { type: 'time', axisLabel: { color: '#888', hideOverlap: true, fontSize: isMobile.value ? 10 : 12 } },
        yAxis: { type: 'value', scale: true, axisLabel: { color: '#888', fontSize: isMobile.value ? 10 : 12 } },
        series,
      },
      { notMerge: true },
    );
    loading.value = false;
  } catch {
    loading.value = false;
  }
}

watch([picked, windowMinutes], () => {
  loading.value = true;
  refresh();
});

useChartAutoResize(chartEl, () => chart);

onMounted(() => {
  chart = echarts.init(chartEl.value!);
  refresh();
  timer = setInterval(refresh, 60_000);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  chart?.dispose();
});
</script>

<template>
  <n-spin :show="loading">
    <n-card title="传感器历史趋势（保留最近 30 天）">
      <n-space vertical size="large">
        <n-alert v-if="available.length === 0 && !loading" type="info" :bordered="false">
          暂无历史数据，登录后约 30 秒开始积累。
        </n-alert>
        <n-space align="center" :size="12">
          <n-select
            v-model:value="picked"
            :options="available.map((s) => ({ label: s, value: s }))"
            multiple
            filterable
            :max-tag-count="isMobile ? 2 : 4"
            size="small"
            :style="isMobile ? 'width: 100%' : 'min-width: 420px'"
            placeholder="选择传感器"
          />
          <n-select v-model:value="windowMinutes" :options="windowOptions" size="small" :style="isMobile ? 'width: 100%' : 'width: 150px'" />
        </n-space>
        <div v-if="picked.length > 0" ref="chartEl" :style="{ height: isMobile ? '260px' : '380px' }" />
        <n-empty v-else description="选择要查看的传感器" />
      </n-space>
    </n-card>
  </n-spin>
</template>
