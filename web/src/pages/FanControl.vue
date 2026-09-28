<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  NCard, NAlert, NSelect, NSpace, NSpin, NTag, NButton, NInputNumber, NInputGroup,
  NModal, NForm, NFormItem, NInput, NCheckbox, NPopconfirm, NUpload, NUploadDragger, useDialog, useMessage,
} from 'naive-ui';
import type { UploadFileInfo } from 'naive-ui';
import * as echarts from 'echarts';
import { bmcGet, bmcSend } from '../api';
import { WRITE_OPS_ENABLED } from '../config';
import type { FanProfile, FanPolicy, Sensor } from '../types';

const message = useMessage();
const dialog = useDialog();

const profiles = ref<FanProfile[]>([]);
const mode = ref('');
const sensors = ref<Sensor[]>([]);
const pcieDevices = ref<{ strName: string; hexVendorID: string; hexDeviceID: string }[]>([]);
const selectedName = ref('');
const loading = ref(true);
const chartEl = ref<HTMLDivElement>();
let chart: echarts.ECharts | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

// ---------- 编辑状态（当前 profile 的深拷贝） ----------
const editing = ref<FanProfile | null>(null);
const dirty = ref(false);

const current = computed(() => profiles.value.find((p) => p.strName === selectedName.value));
const isRunning = computed(() => mode.value === selectedName.value);

/** GET 响应里没有的隐藏字段（bundle 逆向所得），编辑前补齐默认值 */
function normalizePolicy(pol: FanPolicy): FanPolicy {
  return {
    ...pol,
    arrHexVendorID: (pol as FanPolicy & { arrHexVendorID?: string[] }).arrHexVendorID ?? [],
    arrHexDeviceID: (pol as FanPolicy & { arrHexDeviceID?: string[] }).arrHexDeviceID ?? [],
    iPCIEDeviceEnable: (pol as FanPolicy & { iPCIEDeviceEnable?: number }).iPCIEDeviceEnable ?? 0,
    iHysteresis: (pol as FanPolicy & { iHysteresis?: number }).iHysteresis ?? 0,
  };
}

function newProfile(name: string): FanProfile {
  return {
    strVersion: '1.00',
    strName: name,
    arrPolicy: [
      {
        iPolicyType: 2, iInSDR: 1, iSensorCode: 1, iInitDuty: 30,
        iCpuTdp: 0, iAmbientSensor: 0, iAmbientSensorTemp: 0,
        arrSensor: [], arrFanSensor: [],
        arrRef: [40, 30, 20, 10], arrDuty: [30, 60, 85, 100],
        arrHexVendorID: [], arrHexDeviceID: [], iPCIEDeviceEnable: 0, iHysteresis: 0,
      } as FanPolicy,
    ],
  };
}

function loadForEdit(name: string | null) {
  if (name === null) {
    editing.value = newProfile('NEW_PROFILE');
  } else {
    const src = profiles.value.find((p) => p.strName === name);
    if (!src) return;
    editing.value = JSON.parse(JSON.stringify({ ...src, arrPolicy: src.arrPolicy.map(normalizePolicy) })) as FanProfile;
  }
  dirty.value = false;
}

function markDirty() {
  dirty.value = true;
  drawCurve();
}

// ---------- 曲线图 ----------
function drawCurve() {
  const pol = editing.value?.arrPolicy[0];
  if (!pol || !chart) return;
  const points = pol.arrRef.map((r, i) => [r, pol.arrDuty[i]]);
  const runs = profiles.value.find((p) => p.strName === selectedName.value);
  const runPol = runs?.arrPolicy[0];
  const series: echarts.SeriesOption[] = [
    {
      name: '编辑中',
      type: 'line',
      step: 'end',
      data: points,
      lineStyle: { color: '#63e2b7', width: 2 },
      itemStyle: { color: '#63e2b7' },
      symbolSize: 8,
    },
  ];
  if (runPol && editing.value && runPol !== pol) {
    series.push({
      name: '当前生效',
      type: 'line',
      step: 'end',
      data: runPol.arrRef.map((r, i) => [r, runPol.arrDuty[i]]),
      lineStyle: { color: '#888', type: 'dashed' },
      itemStyle: { color: '#888' },
      symbolSize: 4,
    });
  }
  chart.setOption({
    animation: false,
    tooltip: { trigger: 'axis' },
    legend: { top: 0, textStyle: { color: '#aaa', fontSize: 11 } },
    grid: { left: 50, right: 20, top: 36, bottom: 40 },
    xAxis: { type: 'value', name: 'Reference', nameTextStyle: { color: '#888' }, axisLabel: { color: '#888' } },
    yAxis: { type: 'value', name: 'Duty (%)', min: 0, max: 100, nameTextStyle: { color: '#888' }, axisLabel: { color: '#888' } },
    series,
  }, { notMerge: true });
}

// ---------- 传感器选项 ----------
const tempSensorOptions = computed(() =>
  sensors.value.filter((s) => s.unit.toLowerCase() === 'deg_c').map((s) => ({ label: `${s.name} (#${s.sensor_number})`, value: s.sensor_number })),
);
const fanSensorOptions = computed(() =>
  sensors.value.filter((s) => s.unit.toLowerCase() === 'rpm').map((s) => ({ label: `${s.name} (#${s.sensor_number})`, value: s.sensor_number })),
);
const ambientOptions = computed(() => [{ label: 'N/A', value: 0 }, ...tempSensorOptions.value]);

// ---------- 曲线点编辑 ----------
function addPoint() {
  const pol = editing.value?.arrPolicy[0];
  if (!pol) return;
  pol.arrRef.push(0);
  pol.arrDuty.push(100);
  markDirty();
}
function removePoint(i: number) {
  const pol = editing.value?.arrPolicy[0];
  if (!pol || pol.arrRef.length <= 1) return;
  pol.arrRef.splice(i, 1);
  pol.arrDuty.splice(i, 1);
  markDirty();
}

// ---------- 数据加载 ----------
async function refresh(keepSelection = true) {
  try {
    const [profilesData, modeData, sensorsData] = await Promise.all([
      bmcGet<FanProfile[]>('settings/fanprofile/collection'),
      bmcGet<{ strMode: string }>('settings/fanprofile/mode'),
      bmcGet<Sensor[]>('sensors'),
    ]);
    let devices: { strName: string; hexVendorID: string; hexDeviceID: string }[] = [];
    try {
      devices = await bmcGet<{ strName: string; hexVendorID: string; hexDeviceID: string }[]>('settings/fanprofile/device_define/collection');
    } catch {
      /* 可选端点 */
    }
    profiles.value = profilesData;
    mode.value = modeData.strMode;
    sensors.value = sensorsData;
    pcieDevices.value = devices;
    if (!keepSelection || !selectedName.value) selectedName.value = modeData.strMode || profilesData[0]?.strName || '';
    if (!editing.value) loadForEdit(selectedName.value);
    drawCurve();
    loading.value = false;
  } catch {
    loading.value = false;
  }
}

// ---------- 写操作（全部 gated by WRITE_OPS_ENABLED） ----------
const showNewModal = ref(false);
const newName = ref('');

function requireWrite(): boolean {
  if (!WRITE_OPS_ENABLED) {
    message.warning('写操作已禁用（开发纪律）。验证通过后在 web/src/config.ts 打开 WRITE_OPS_ENABLED。');
    return false;
  }
  return true;
}

async function saveProfile() {
  if (!requireWrite() || !editing.value) return;
  const pol = editing.value.arrPolicy[0];
  if (pol.arrSensor.length === 0) return message.error('请至少选择一个源传感器');
  if (pol.arrFanSensor.length === 0) return message.error('请至少选择一个被控风扇');
  const pairs = pol.arrRef.map((r, i) => `${r}→${pol.arrDuty[i]}%`).join('  ');
  dialog.warning({
    title: `保存设定档「${editing.value.strName}」`,
    content: `POST /api/settings/fanprofile/collection\n曲线：${pairs}`,
    positiveText: '写入 BMC',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await bmcSend('POST', 'settings/fanprofile/collection', editing.value);
        message.success('已写入');
        editing.value = null;
        await refresh();
      } catch (e) {
        message.error((e as Error).message);
      }
    },
  });
}

async function playProfile(name: string) {
  if (!requireWrite()) return;
  dialog.warning({
    title: `应用设定档「${name}」？`,
    content: 'POST /api/settings/fanprofile/mode — 风扇转速将立即按该曲线调整',
    positiveText: '应用',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await bmcSend('POST', 'settings/fanprofile/mode', { strMode: name });
        message.success(`已应用：${name}`);
        await refresh();
      } catch (e) {
        message.error((e as Error).message);
      }
    },
  });
}

async function stopProfile() {
  if (!requireWrite()) return;
  dialog.warning({
    title: '停止当前设定档？',
    content: '将 strMode 恢复为 default（回归默认曲线）',
    positiveText: '停止',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await bmcSend('POST', 'settings/fanprofile/mode', { strMode: 'default' });
        message.success('已恢复 default');
        await refresh();
      } catch (e) {
        message.error((e as Error).message);
      }
    },
  });
}

async function deleteProfile(name: string) {
  if (!requireWrite()) return;
  try {
    await bmcSend('DELETE', `settings/fanprofile/collection/${encodeURIComponent(name)}`);
    message.success(`已删除：${name}`);
    await refresh(false);
  } catch (e) {
    message.error((e as Error).message + '（删除端点为推断路径，如失败需对照原版 UI 抓包修正）');
  }
}

// ---------- 导入 / 导出 ----------
function exportProfile() {
  const p = editing.value ?? current.value;
  if (!p) return;
  const blob = new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${p.strName}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function onImport({ file }: { file: UploadFileInfo }) {
  if (!file.file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result)) as FanProfile;
      if (!parsed.strName || !parsed.arrPolicy) throw new Error('格式不对');
      editing.value = { ...parsed, arrPolicy: parsed.arrPolicy.map(normalizePolicy) };
      dirty.value = true;
      drawCurve();
      message.success(`已导入「${parsed.strName}」，检查后点保存`);
    } catch (e) {
      message.error(`导入失败：${(e as Error).message}`);
    }
  };
  reader.readAsText(file.file);
}

function onTabSelect(name: string) {
  if (dirty.value) {
    dialog.warning({
      title: '有未保存的修改',
      content: '切换将丢弃修改，继续？',
      positiveText: '丢弃并切换',
      negativeText: '留在当前',
      onPositiveClick: () => {
        loadForEdit(name);
      },
    });
  } else {
    loadForEdit(name);
  }
}

watch(selectedName, (v) => {
  if (!editing.value) loadForEdit(v);
});

onMounted(() => {
  chart = echarts.init(chartEl.value!);
  refresh();
  timer = setInterval(refresh, 5000);
  window.addEventListener('resize', () => chart?.resize());
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  chart?.dispose();
});

const profileOptions = computed(() => profiles.value.map((p) => ({ label: p.strName + (p.strName === mode.value ? '（运行中）' : ''), value: p.strName })));
const pol = computed(() => editing.value?.arrPolicy[0]);
</script>

<template>
  <n-spin :show="loading">
    <n-space vertical size="large">
      <n-alert type="info" :bordered="false">
        当前生效设定档：<n-tag type="success" size="small">{{ mode || '—' }}</n-tag>
        <template v-if="!WRITE_OPS_ENABLED">
          · <b>写入/应用/删除已禁用</b>（开发纪律：写通道按协议实现，验证后在 config.ts 开启）
        </template>
      </n-alert>

      <n-card title="风扇设定档">
        <template #header-extra>
          <n-space>
            <n-select
              :value="selectedName"
              :options="profileOptions"
              style="width: 220px"
              size="small"
              @update:value="onTabSelect"
            />
            <n-button size="small" @click="loadForEdit(null); showNewModal = false">新建</n-button>
            <n-button size="small" :disabled="isRunning" @click="playProfile(selectedName)">应用</n-button>
            <n-button size="small" :disabled="mode === 'default'" @click="stopProfile">停止</n-button>
            <n-popconfirm v-if="current" @positive-click="deleteProfile(selectedName)">
              <template #trigger>
                <n-button size="small" type="error" secondary :disabled="isRunning">删除</n-button>
              </template>
              确认删除「{{ selectedName }}」？
            </n-popconfirm>
          </n-space>
        </template>

        <div ref="chartEl" style="height: 300px" />

        <template v-if="editing && pol">
          <n-space vertical size="medium" style="margin-top: 16px">
            <n-space align="center" :size="16">
              <span class="lbl">设定档名称</span>
              <n-input v-model:value="editing.strName" size="small" style="width: 200px" @update:value="markDirty" />
              <span class="lbl">初始 Duty (%)</span>
              <n-input-number v-model:value="pol.iInitDuty" size="small" :min="0" :max="100" @update:value="markDirty" />
              <span class="lbl">滞回 iHysteresis</span>
              <n-input-number v-model:value="pol.iHysteresis" size="small" :min="0" :max="100" @update:value="markDirty" />
            </n-space>

            <n-space align="center" :size="16">
              <span class="lbl">源传感器（温度）</span>
              <n-select
                v-model:value="pol.arrSensor"
                :options="tempSensorOptions"
                multiple
                size="small"
                style="min-width: 280px"
                placeholder="选择温度源"
                @update:value="markDirty"
              />
              <span class="lbl">被控风扇</span>
              <n-select
                v-model:value="pol.arrFanSensor"
                :options="fanSensorOptions"
                multiple
                size="small"
                style="min-width: 280px"
                placeholder="选择风扇"
                @update:value="markDirty"
              />
            </n-space>

            <div>
              <n-space justify="space-between" align="center" style="margin-bottom: 6px">
                <span class="lbl">Policy Reference Table（Reference → Duty 曲线点，Slope 算法）</span>
                <n-button size="tiny" @click="addPoint">+ 加点</n-button>
              </n-space>
              <n-space vertical size="small">
                <n-space v-for="(_, i) in pol.arrRef" :key="i" align="center" :size="8">
                  <span class="pt">点 {{ i }}</span>
                  <n-input-number v-model:value="pol.arrRef[i]" size="small" style="width: 120px" @update:value="markDirty" />
                  <span>→</span>
                  <n-input-number v-model:value="pol.arrDuty[i]" size="small" style="width: 110px" :min="0" :max="100" @update:value="markDirty">
                    <template #suffix>%</template>
                  </n-input-number>
                  <n-button size="tiny" quaternary type="error" :disabled="pol.arrRef.length <= 1" @click="removePoint(i)">删</n-button>
                </n-space>
              </n-space>
            </div>

            <n-space align="center" :size="16">
              <span class="lbl">执行条件</span>
              <n-checkbox :checked="pol.iCpuTdp > 0" @update:checked="(v: boolean) => { pol.iCpuTdp = v ? (pol.iCpuTdp || 280) : 0; markDirty(); }">
                CPU TDP (W)
              </n-checkbox>
              <n-input-number v-if="pol.iCpuTdp > 0" v-model:value="pol.iCpuTdp" size="small" style="width: 110px" @update:value="markDirty" />
              <n-checkbox :checked="pol.iAmbientSensor > 0" @update:checked="(v: boolean) => { pol.iAmbientSensor = v ? (pol.iAmbientSensor || tempSensorOptions[0]?.value || 0) : 0; markDirty(); }">
                环境温度传感器
              </n-checkbox>
              <n-select
                v-if="pol.iAmbientSensor > 0"
                v-model:value="pol.iAmbientSensor"
                :options="ambientOptions"
                size="small"
                style="width: 200px"
                @update:value="markDirty"
              />
              <n-checkbox
                :checked="pol.iPCIEDeviceEnable === 1"
                @update:checked="(v: boolean) => { pol.iPCIEDeviceEnable = v ? 1 : 0; markDirty(); }"
              >
                PCIe 设备条件
              </n-checkbox>
            </n-space>
            <n-select
              v-if="pol.iPCIEDeviceEnable === 1"
              v-model:value="pol.arrHexDeviceID"
              :options="pcieDevices.map((d) => ({ label: `${d.strName} (${d.hexVendorID}:${d.hexDeviceID})`, value: d.hexDeviceID }))"
              multiple
              size="small"
              style="max-width: 500px"
              placeholder="选择设备（按 DeviceID 匹配）"
              @update:value="markDirty"
            />

            <n-space>
              <n-button type="primary" :disabled="!dirty" @click="saveProfile">保存到 BMC</n-button>
              <n-button :disabled="!dirty" @click="loadForEdit(editing.strName === 'NEW_PROFILE' ? null : selectedName)">还原</n-button>
              <n-button @click="exportProfile">导出 JSON</n-button>
              <n-upload :show-file-list="false" :max="1" @change="onImport">
                <n-button size="small">导入 JSON</n-button>
              </n-upload>
            </n-space>
          </n-space>
        </template>
      </n-card>

      <n-card title="实时转速">
        <n-space :size="24">
          <span v-for="s in sensors.filter((x) => x.unit.toLowerCase() === 'rpm')" :key="s.name">
            {{ s.name }}：<b>{{ s.reading }} RPM</b>
          </span>
        </n-space>
      </n-card>
    </n-space>

    <n-modal v-model:show="showNewModal" preset="dialog" title="新建设定档">
      <n-form @submit.prevent>
        <n-form-item label="名称">
          <n-input v-model:value="newName" placeholder="NEW_PROFILE" />
        </n-form-item>
      </n-form>
      <template #action>
        <n-button @click="showNewModal = false">取消</n-button>
        <n-button
          type="primary"
          @click="
            editing && (editing.strName = newName || 'NEW_PROFILE'),
            (showNewModal = false),
            markDirty()
          "
        >
          创建
        </n-button>
      </template>
    </n-modal>
  </n-spin>
</template>

<style scoped>
.lbl {
  color: #999;
  font-size: 12px;
}
.pt {
  color: #777;
  font-size: 12px;
  width: 36px;
}
</style>
