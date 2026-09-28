<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { NCard, NGrid, NGi, NSpace, NStatistic, NTag, NAlert, NSpin } from 'naive-ui';
import * as echarts from 'echarts';
import { bmcGet } from '../api';
import type { ChassisStatus, FirmwareInfo, Sensor, Uptime } from '../types';
import { useIsMobile } from '../useMediaQuery';
import { useChartAutoResize } from '../useChartAutoResize';

const isMobile = useIsMobile();

const firmware = ref<FirmwareInfo | null>(null);
const uptime = ref<Uptime | null>(null);
const powerStatus = ref<number | null>(null);
const sensors = ref<Sensor[]>([]);
const loading = ref(true);

// 实时曲线缓冲（客户端内存，最近 120 个采样点）
const buf = reactive<{ temps: Map<string, { t: number; v: number }[]>; fans: Map<string, { t: number; v: number }[]> }>({
  temps: new Map(),
  fans: new Map(),
});

const tempChartEl = ref<HTMLDivElement>();
const fanChartEl = ref<HTMLDivElement>();
let tempChart: echarts.ECharts | null = null;
let fanChart: echarts.ECharts | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

const TEMP_KEYS = ['CPU0_TEMP', 'CPU0_DTS', 'MB_TEMP1', 'MB_TEMP2'];
const FAN_KEYS = ['CPU0_FAN', 'SYS_FAN1', 'SYS_FAN2', 'SYS_FAN3', 'SYS_FAN4'];

function push(map: Map<string, { t: number; v: number }[]>, key: string, v: number) {
  if (!map.has(key)) map.set(key, []);
  const arr = map.get(key)!;
  arr.push({ t: Date.now(), v });
  if (arr.length > 120) arr.shift();
}

function lineOption(map: Map<string, { t: number; v: number }[]>, yName: string): echarts.EChartsOption {
  const series: echarts.SeriesOption[] = [];
  for (const [key, points] of map) {
    if (points.length === 0) continue;
    series.push({
      name: key,
      type: 'line',
      showSymbol: false,
      smooth: true,
      data: points.map((p) => [p.t, p.v]),
    });
  }
  // 窄屏：图例缩小换行，并按图例行数动态预留顶部空间（Y 轴单位名也在顶部）
  const legendRows = Math.min(3, Math.ceil(series.length / 4));
  return {
    animation: false,
    tooltip: { trigger: 'axis' },
    legend: isMobile.value
      ? { top: 0, textStyle: { color: '#bbb', fontSize: 10 }, itemGap: 6, itemWidth: 12, itemHeight: 8 }
      : { top: 0, textStyle: { color: '#aaa', fontSize: 11 } },
    grid: {
      left: 44,
      right: 12,
      top: isMobile.value ? 20 + legendRows * 18 : 30,
      bottom: 24,
    },
    xAxis: { type: 'time', axisLabel: { color: '#888', hideOverlap: true, fontSize: isMobile.value ? 10 : 12 } },
    yAxis: {
      type: 'value',
      name: yName,
      nameTextStyle: { color: '#888', fontSize: isMobile.value ? 10 : 12 },
      axisLabel: { color: '#888', fontSize: isMobile.value ? 10 : 12 },
      scale: true,
    },
    series,
  };
}

async function refresh() {
  try {
    const [sensorsData, chassis] = await Promise.all([
      bmcGet<Sensor[]>('sensors'),
      bmcGet<ChassisStatus>('chassis-status'),
    ]);
    sensors.value = sensorsData;
    powerStatus.value = chassis.power_status;
    for (const s of sensorsData) {
      const unit = s.unit.toLowerCase();
      if (unit === 'deg_c' && TEMP_KEYS.includes(s.name)) push(buf.temps, s.name, s.reading);
      if (unit === 'rpm' && FAN_KEYS.includes(s.name)) push(buf.fans, s.name, s.reading);
    }
    tempChart?.setOption(lineOption(buf.temps, '°C'));
    fanChart?.setOption(lineOption(buf.fans, 'RPM'));
  } catch {
    /* 401 已由 api 层处理 */
  } finally {
    loading.value = false;
  }
}

function fmtUptime(u: Uptime | null): string {
  if (!u) return '—';
  const hours = (u.minutes_per_count * u.poh_counter_reading) / 60;
  const days = Math.floor(hours / 24);
  return `${days} 天 ${Math.round(hours % 24)} 小时`;
}

function sensorValue(name: string): string {
  const s = sensors.value.find((x) => x.name === name);
  if (!s) return '—';
  const unit = s.unit.toLowerCase();
  return `${s.reading}${unit === 'deg_c' ? '°C' : unit === 'rpm' ? ' RPM' : ''}`;
}

useChartAutoResize(tempChartEl, () => tempChart);
useChartAutoResize(fanChartEl, () => fanChart);

onMounted(async () => {
  tempChart = echarts.init(tempChartEl.value!);
  fanChart = echarts.init(fanChartEl.value!);
  try {
    firmware.value = await bmcGet<FirmwareInfo>('firmware-info');
    uptime.value = await bmcGet<Uptime>('status/uptime');
  } catch {
    /* 忽略，界面显示占位 */
  }
  await refresh();
  timer = setInterval(refresh, 3000);
});

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  tempChart?.dispose();
  fanChart?.dispose();
});
</script>

<template>
  <n-spin :show="loading">
    <n-space vertical size="large">
      <n-alert v-if="powerStatus === 1" type="success" :bordered="false">主机已上电</n-alert>
      <n-alert v-else-if="powerStatus === 0" type="warning" :bordered="false">主机关机 / 未上电</n-alert>

      <n-grid :cols="isMobile ? 1 : 4" :x-gap="12" :y-gap="12">
        <n-gi>
          <n-card size="small">
            <n-statistic label="BMC 固件" :value="firmware?.fw_ver ?? '—'" />
            <template #footer><span class="dim">构建于 {{ firmware?.date ?? '—' }}</span></template>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card size="small">
            <n-statistic label="开机时长 (POH)" :value="fmtUptime(uptime)" />
          </n-card>
        </n-gi>
        <n-gi>
          <n-card size="small">
            <n-statistic label="CPU 温度" :value="sensorValue('CPU0_TEMP')" />
            <template #footer><span class="dim">DTS {{ sensorValue('CPU0_DTS') }}</span></template>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card size="small">
            <n-statistic label="CPU 风扇" :value="sensorValue('CPU0_FAN')" />
            <template #footer><span class="dim">主板 {{ sensorValue('MB_TEMP1') }}</span></template>
          </n-card>
        </n-gi>
      </n-grid>

      <n-grid :cols="isMobile ? 1 : 2" :x-gap="12" :y-gap="12">
        <n-gi>
          <n-card title="温度趋势" size="small">
            <div ref="tempChartEl" :style="{ height: isMobile ? '200px' : '240px' }" />
          </n-card>
        </n-gi>
        <n-gi>
          <n-card title="风扇转速" size="small">
            <div ref="fanChartEl" :style="{ height: isMobile ? '200px' : '240px' }" />
          </n-card>
        </n-gi>
      </n-grid>
    </n-space>
  </n-spin>
</template>

<style scoped>
.dim {
  color: #777;
  font-size: 12px;
}
</style>
