<script setup lang="ts">
// 实时趋势图（多条折线）。仪表盘与历史页共用，避免两处重复写 ECharts 配置。
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as echarts from 'echarts';
import { useChartAutoResize } from '../useChartAutoResize';
import { useIsMobile } from '../useMediaQuery';
import { CHART_COLORS } from '../chartTheme';

export interface TrendPoint {
  t: number;
  v: number;
}
export interface TrendSeries {
  name: string;
  points: TrendPoint[];
}

const props = withDefaults(
  defineProps<{
    series: TrendSeries[];
    yName?: string;
    height?: number;
    /** 纵轴最小值（风扇转速等从 0 起更直观；温度留自适应） */
    min?: number | 'dataMin';
  }>(),
  { yName: '', height: 240, min: undefined },
);

const isMobile = useIsMobile();
const el = ref<HTMLDivElement>();
let chart: echarts.ECharts | null = null;

function option(): echarts.EChartsOption {
  const series: echarts.SeriesOption[] = props.series
    .filter((s) => s.points.length > 0)
    .map((s) => ({
      name: s.name,
      type: 'line' as const,
      showSymbol: false,
      smooth: true,
      data: s.points.map((p) => [p.t, p.v]),
    }));
  // 窄屏图例更小并换行；顶部预留图例行数，避免压住 Y 轴单位名
  const legendRows = Math.min(3, Math.ceil(series.length / (isMobile.value ? 3 : 5)));
  return {
    animation: false,
    tooltip: { trigger: 'axis' },
    legend: {
      top: 4,
      type: 'scroll',
      itemWidth: isMobile.value ? 10 : 16,
      itemHeight: isMobile.value ? 6 : 9,
      textStyle: { color: isMobile.value ? CHART_COLORS.legendTextCompact : CHART_COLORS.legendText, fontSize: isMobile.value ? 10 : 12 },
    },
    grid: { left: 8, right: 12, bottom: 6, top: 22 + legendRows * (isMobile.value ? 16 : 22), containLabel: true },
    xAxis: {
      type: 'time',
      axisLabel: { color: CHART_COLORS.axisText, fontSize: isMobile.value ? 10 : 11, hideOverlap: true },
      axisLine: { lineStyle: { color: '#444' } },
    },
    yAxis: {
      type: 'value',
      name: props.yName,
      nameTextStyle: { color: CHART_COLORS.axisText, fontSize: isMobile.value ? 10 : 11 },
      axisLabel: { color: CHART_COLORS.axisText, fontSize: isMobile.value ? 10 : 11 },
      splitLine: { lineStyle: { color: '#333' } },
      ...(props.min === undefined ? {} : { min: props.min }),
    },
    series,
  };
}

function render() {
  if (!chart || !el.value) return;
  chart.setOption(option(), { notMerge: false });
}

onMounted(() => {
  if (!el.value) return;
  chart = echarts.init(el.value, undefined, { renderer: 'canvas' });
  render();
});
onBeforeUnmount(() => {
  chart?.dispose();
  chart = null;
});
watch(() => props.series, render, { deep: true });
useChartAutoResize(el, () => chart);
</script>

<template>
  <div ref="el" :style="{ width: '100%', height: height + 'px' }" />
</template>
