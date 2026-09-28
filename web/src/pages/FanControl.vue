<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { NCard, NAlert, NSelect, NSpace, NSpin, NTag } from 'naive-ui';
import * as echarts from 'echarts';
import { bmcGet } from '../api';
import type { FanProfile, Sensor } from '../types';

const profiles = ref<FanProfile[]>([]);
const mode = ref('');
const sensors = ref<Sensor[]>([]);
const selected = ref('');
const loading = ref(true);
const chartEl = ref<HTMLDivElement>();
let chart: echarts.ECharts | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

const profileOptions = () => profiles.value.map((p) => ({ label: p.strName, value: p.strName }));

function draw() {
  const p = profiles.value.find((x) => x.strName === selected.value);
  if (!p || p.arrPolicy.length === 0 || !chart) return;
  const pol = p.arrPolicy[0];
  const points = pol.arrRef.map((r, i) => [r, pol.arrDuty[i]]);
  chart.setOption({
    animation: false,
    tooltip: { trigger: 'axis' },
    grid: { left: 50, right: 20, top: 36, bottom: 40 },
    xAxis: { type: 'value', name: 'Reference', nameTextStyle: { color: '#888' }, axisLabel: { color: '#888' } },
    yAxis: { type: 'value', name: 'Duty (%)', min: 0, max: 100, nameTextStyle: { color: '#888' }, axisLabel: { color: '#888' } },
    series: [
      {
        name: 'Reference→Duty',
        type: 'line',
        step: 'end',
        data: points,
        lineStyle: { color: '#63e2b7' },
        itemStyle: { color: '#63e2b7' },
        symbolSize: 8,
      },
    ],
  });
}

function fanReading(name: string): string {
  const s = sensors.value.find((x) => x.name === name);
  return s ? `${s.reading} RPM` : '—';
}

async function refresh() {
  try {
    const [profilesData, modeData, sensorsData] = await Promise.all([
      bmcGet<FanProfile[]>('settings/fanprofile/collection'),
      bmcGet<{ strMode: string }>('settings/fanprofile/mode'),
      bmcGet<Sensor[]>('sensors'),
    ]);
    profiles.value = profilesData;
    mode.value = modeData.strMode;
    sensors.value = sensorsData;
    if (!selected.value && profilesData.length) selected.value = modeData.strMode || profilesData[0].strName;
    draw();
    loading.value = false;
  } catch {
    loading.value = false;
  }
}

onMounted(() => {
  chart = echarts.init(chartEl.value!);
  refresh();
  timer = setInterval(refresh, 3000);
  window.addEventListener('resize', () => chart?.resize());
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  chart?.dispose();
});
</script>

<template>
  <n-spin :show="loading">
    <n-space vertical size="large">
      <n-alert type="info" :bordered="false">
        当前生效设定档：<n-tag type="success" size="small">{{ mode || '—' }}</n-tag>
        · 风扇曲线编辑与写入功能将在阶段④实现（写操作验证前保持禁用）
      </n-alert>

      <n-card title="风扇设定档（只读预览）">
        <template #header-extra>
          <n-space>
            <n-select v-model:value="selected" :options="profileOptions()" style="width: 200px" size="small" @update:value="draw" />
          </n-space>
        </template>
        <div ref="chartEl" style="height: 300px" />
        <div v-if="profiles.find((p) => p.strName === selected)" class="detail">
          <div>源传感器：{{ profiles.find((p) => p.strName === selected)!.arrPolicy[0].arrSensor.join(', ') }}（CPU0_DTS=12）</div>
          <div>被控风扇：CPU0_FAN、SYS_FAN1~5（sensor_number {{ profiles.find((p) => p.strName === selected)!.arrPolicy[0].arrFanSensor.join(', ') }}）</div>
          <div>初始 Duty：{{ profiles.find((p) => p.strName === selected)!.arrPolicy[0].iInitDuty }}%</div>
          <div>算法：Slope · 曲线点：{{ JSON.stringify(profiles.find((p) => p.strName === selected)!.arrPolicy[0].arrRef) }} → {{ JSON.stringify(profiles.find((p) => p.strName === selected)!.arrPolicy[0].arrDuty) }}</div>
        </div>
      </n-card>

      <n-card title="实时转速">
        <n-space :size="24">
          <span v-for="f in ['CPU0_FAN', 'SYS_FAN1', 'SYS_FAN2', 'SYS_FAN3', 'SYS_FAN4']" :key="f">
            {{ f }}：<b>{{ fanReading(f) }}</b>
          </span>
        </n-space>
      </n-card>
    </n-space>
  </n-spin>
</template>

<style scoped>
.detail {
  color: #999;
  font-size: 12px;
  line-height: 1.8;
  margin-top: 12px;
}
</style>
