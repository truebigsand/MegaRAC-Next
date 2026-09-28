<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  NCard, NAlert, NSelect, NSpace, NSpin, NTag, NButton, NInputNumber,
  NInput, NCheckbox, NPopconfirm, NUpload, useDialog, useMessage,
} from 'naive-ui';
import type { UploadFileInfo } from 'naive-ui';
import * as echarts from 'echarts';
import { bmcGet, bmcSend } from '../api';
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
/** 编辑器当前内容对应的服务端档案名；null = 新建中（尚未保存） */
const sourceName = ref<string | null>(null);
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
        // 默认曲线按"越热越快"给（普通温度源的常规方向）
        arrRef: [40, 50, 60, 70], arrDuty: [30, 60, 85, 100],
        arrHexVendorID: [], arrHexDeviceID: [], iPCIEDeviceEnable: 0, iHysteresis: 0,
      } as FanPolicy,
    ],
  };
}

function nextNewName(): string {
  const base = 'NEW_PROFILE';
  if (!profiles.value.some((p) => p.strName === base)) return base;
  for (let i = 2; ; i++) {
    const name = `${base}_${i}`;
    if (!profiles.value.some((p) => p.strName === name)) return name;
  }
}

/** 载入档案到编辑器；同时把下拉选择同步过去（selectedName 为空表示正在新建） */
function loadForEdit(name: string | null) {
  sourceName.value = name;
  if (name === null) {
    editing.value = newProfile(nextNewName());
    selectedName.value = '';
    dirty.value = true; // 新档案本身即未保存状态，保存/还原立即可用
  } else {
    const src = profiles.value.find((p) => p.strName === name);
    if (!src) return;
    editing.value = JSON.parse(JSON.stringify({ ...src, arrPolicy: src.arrPolicy.map(normalizePolicy) })) as FanProfile;
    selectedName.value = name;
    dirty.value = false;
  }
  drawCurve();
}

/** 还原：丢弃未保存改动。新建中则退出新建、回到运行中的档案 */
function revert() {
  if (sourceName.value === null) {
    loadForEdit(mode.value || profiles.value[0]?.strName || null);
  } else {
    loadForEdit(sourceName.value);
  }
}

function markDirty() {
  dirty.value = true;
  drawCurve();
}

/** 按固件顺序规范取曲线点（升序；DTS 源倒序）—— 图表与保存都以此顺序为准 */
function orderedPoints(pol: FanPolicy): [number, number][] {
  const pairs = pol.arrRef.map((r, i) => [r, pol.arrDuty[i]] as [number, number]);
  pairs.sort((a, b) => a[0] - b[0]);
  if (isDtsSource(pol)) pairs.reverse();
  return pairs;
}

/** 曲线点是否非单调（有回折）——只有这种顺序会让曲线图出现折返线 */
const orderNonMonotonic = computed(() => {
  const refs = editing.value?.arrPolicy[0]?.arrRef ?? [];
  if (refs.length < 3) return false;
  let dir = 0;
  for (let i = 1; i < refs.length; i++) {
    const d = Math.sign(refs[i] - refs[i - 1]);
    if (d === 0) continue;
    if (dir === 0) dir = d;
    else if (d !== dir) return true;
  }
  return false;
});

// ---------- 曲线图 ----------
function drawCurve() {
  const pol = editing.value?.arrPolicy[0];
  if (!pol || !chart) return;
  const runPol = profiles.value.find((p) => p.strName === mode.value)?.arrPolicy[0];
  const isEditingRunning = editing.value?.strName === mode.value;
  const series: echarts.SeriesOption[] = [
    {
      name: isEditingRunning ? '当前运行' : '编辑中',
      type: 'line',
      step: 'end',
      data: orderedPoints(pol),
      lineStyle: { color: '#63e2b7', width: 2 },
      itemStyle: { color: '#63e2b7' },
      symbolSize: 8,
    },
  ];
  if (runPol && !isEditingRunning) {
    series.push({
      name: `当前运行（${mode.value}）`,
      type: 'line',
      step: 'end',
      data: orderedPoints(runPol),
      lineStyle: { color: '#888', type: 'dashed' },
      itemStyle: { color: '#888' },
      symbolSize: 4,
    });
  }
  // AMD DTS 传感器读的是"距临界温度的余量"（Tcrit − 实际温度），越小越热。
  // 与原版一致：DTS 源时横轴反向（左冷右热），曲线才能读成"越热→越快"。
  const isDts = isDtsSource(pol);
  chart.setOption({
    animation: false,
    tooltip: { trigger: 'axis' },
    legend: { top: 0, textStyle: { color: '#aaa', fontSize: 11 } },
    grid: { left: 50, right: 20, top: 36, bottom: 40 },
    xAxis: {
      type: 'value',
      inverse: isDts,
      name: isDts ? '温度余量（小=热）' : '传感器读值',
      nameLocation: 'middle',
      nameGap: 28,
      nameTextStyle: { color: '#888' },
      axisLabel: { color: '#888' },
    },
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
/** 固件上限：单策略最多 32 个 Reference 点（原版超出时报 Reach max number of reference support） */
const MAX_REFS = 32;
/** 温度类 SDR 的读数上限（8 位量程），原版新增数据点即取此值 */
const SDR_MAX_REF = 127;

/** 源传感器是否为 DTS（AMD 温度余量）—— 决定曲线顺序规范与横轴方向 */
function isDtsSource(pol: FanPolicy): boolean {
  const src = sensors.value.find((s) => pol.arrSensor.includes(s.sensor_number));
  return !!src && src.name.toUpperCase().includes('DTS');
}

/**
 * 顺序规范化（对齐固件 SortRefTable）：(Reference, Duty) 成对按 Reference 升序，
 * DTS 源再整体倒序 —— 即普通温度存升序、DTS 存降序。
 */
function normalizeOrder(pol: FanPolicy) {
  const pairs = pol.arrRef.map((ref, i) => ({ ref, duty: pol.arrDuty[i] }));
  pairs.sort((a, b) => a.ref - b.ref);
  if (isDtsSource(pol)) pairs.reverse();
  pol.arrRef = pairs.map((p) => p.ref);
  pol.arrDuty = pairs.map((p) => p.duty);
}

/**
 * 执行条件规范化（对齐固件语义）：
 * - 未选环境传感器时其阈值清零
 * - 未启用 PCIe 条件时清空设备列表；启用时按设备库把选中的 DeviceID 展开为
 *   VendorID/DeviceID 两个配对数组（固件按平行数组存储）
 */
function normalizeConditions(pol: FanPolicy) {
  if (pol.iAmbientSensor === 0) pol.iAmbientSensorTemp = 0;
  if (pol.iPCIEDeviceEnable !== 1) {
    pol.arrHexVendorID = [];
    pol.arrHexDeviceID = [];
  } else {
    const picked = pcieDevices.value.filter((d) => pol.arrHexDeviceID.includes(d.hexDeviceID));
    pol.arrHexVendorID = picked.map((d) => d.hexVendorID);
    pol.arrHexDeviceID = picked.map((d) => d.hexDeviceID);
  }
}

function addPoint() {
  const pol = editing.value?.arrPolicy[0];
  if (!pol) return;
  if (pol.arrRef.length >= MAX_REFS) {
    message.warning(`最多 ${MAX_REFS} 个数据点（固件上限）`);
    return;
  }
  pol.arrRef.push(SDR_MAX_REF);
  pol.arrDuty.push(100);
  normalizeOrder(pol);
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
async function refresh() {
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
    if (!editing.value) {
      // 首次进入：载入当前运行档案；没有则取第一个
      loadForEdit(modeData.strMode || profilesData[0]?.strName || null);
    } else {
      drawCurve();
    }
    loading.value = false;
  } catch {
    loading.value = false;
  }
}

// ---------- 写操作 ----------
async function saveProfile() {
  if (!editing.value) return;
  const pol = editing.value.arrPolicy[0];
  if (pol.arrSensor.length === 0) return message.error('请至少选择一个源传感器');
  if (pol.arrFanSensor.length === 0) return message.error('请至少选择一个被控风扇');
  const savedName = editing.value.strName.trim();
  if (!savedName) return message.error('请填写设定档名称');
  const pairs = pol.arrRef.map((r, i) => `${r}→${pol.arrDuty[i]}%`).join('  ');
  const running = savedName === mode.value;
  const existedBefore = sourceName.value;
  const renamed = existedBefore !== null && existedBefore !== savedName;
  const willUpdate = sourceName.value === savedName && profiles.value.some((p) => p.strName === savedName);

  if (renamed) {
    // 改名：固件没有"重命名"接口，只能另建新档案
    dialog.warning({
      title: `名称已修改：${existedBefore} → ${savedName}`,
      content: () =>
        h('div', [
          h('div', `将创建新档案「${savedName}」，原档案「${existedBefore}」保持不动。`),
          h('div', { style: 'color:#999;margin-top:6px' }, '如需删除原档案，请在列表中选中它后点「删除」。'),
        ]),
      positiveText: '创建新档案',
      negativeText: '取消',
      onPositiveClick: async () => {
        try {
          const payload = JSON.parse(JSON.stringify(editing.value)) as FanProfile;
          payload.strName = savedName;
          normalizeOrder(payload.arrPolicy[0]);
          normalizeConditions(payload.arrPolicy[0]);
          await bmcSend('POST', 'settings/fanprofile/collection', payload);
          message.success(`已创建「${savedName}」（原档案「${existedBefore}」保留）`);
          await refresh();
          loadForEdit(savedName);
        } catch (e) {
          showBmcWriteError(e, savedName);
        }
      },
    });
    return;
  }

  if (!willUpdate && profiles.value.some((p) => p.strName === savedName)) {
    return message.error(`档案「${savedName}」已存在，请更换名称，或选中它后再保存`);
  }

  dialog.warning({
    title: `保存设定档「${savedName}」`,
    content: () =>
      h('div', [
        h('div', `曲线：${pairs}`),
        h(
          'div',
          { style: 'color:#999;margin-top:6px' },
          running ? '该档案正在运行，写入后立即更新其配置' : `不会切换运行中的档案（当前为 ${mode.value || '—'}）`,
        ),
      ]),
    positiveText: '写入 BMC',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const payload = JSON.parse(JSON.stringify(editing.value)) as FanProfile;
        normalizeOrder(payload.arrPolicy[0]);
        normalizeConditions(payload.arrPolicy[0]);
        // 已存在的档案用 PUT 更新；新档案用 POST 创建（固件 POST 拒绝重名）
        if (willUpdate) {
          await bmcSend('PUT', `settings/fanprofile/collection/${encodeURIComponent(savedName)}`, payload);
        } else {
          await bmcSend('POST', 'settings/fanprofile/collection', payload);
        }
        message.success(willUpdate ? '已更新' : '已创建');
        await refresh();
        if (profiles.value.some((p) => p.strName === savedName)) {
          loadForEdit(savedName);
        } else {
          selectedName.value = savedName;
          dirty.value = false;
        }
      } catch (e) {
        showBmcWriteError(e, savedName);
      }
    },
  });
}

/** 把固件的英文错误码翻译成可操作的提示 */
function showBmcWriteError(e: unknown, name: string) {
  const msg = (e as Error).message;
  if (msg.includes('Name Already Exist')) {
    message.error(`档案「${name}」已存在：更新已有档案请先选中它，另存为新档案请用「另存为…」`);
  } else {
    message.error(msg);
  }
}

async function playProfile(name: string) {
  const alreadyRunning = mode.value === name;
  dialog.warning({
    title: alreadyRunning ? `重新应用设定档「${name}」？` : `应用设定档「${name}」？`,
    content: alreadyRunning
      ? '该档案已在运行，将重新下发使其读取最新配置'
      : '风扇转速将立即按该曲线调整',
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

// ---------- 另存为（保存为新档案，不切换运行档案） ----------
const showSaveAs = ref(false);
const saveAsName = ref('');

function openSaveAs() {
  if (!editing.value) return;
  saveAsName.value = profiles.value.some((p) => p.strName === `${editing.value!.strName}_copy`)
    ? ''
    : `${editing.value.strName}_copy`;
  showSaveAs.value = true;
}

async function doSaveAs(): Promise<boolean> {
  const name = saveAsName.value.trim();
  if (!name) {
    message.warning('请输入档案名称');
    return false; // 保持弹窗打开
  }
  if (profiles.value.some((p) => p.strName === name)) {
    message.warning(`档案「${name}」已存在，请更换名称`);
    return false;
  }
  const pol = editing.value!.arrPolicy[0];
  if (pol.arrSensor.length === 0) {
    message.error('请至少选择一个源传感器');
    return false;
  }
  if (pol.arrFanSensor.length === 0) {
    message.error('请至少选择一个被控风扇');
    return false;
  }
  try {
    const payload = JSON.parse(JSON.stringify(editing.value)) as FanProfile;
    payload.strName = name;
    normalizeOrder(payload.arrPolicy[0]);
    normalizeConditions(payload.arrPolicy[0]);
    await bmcSend('POST', 'settings/fanprofile/collection', payload);
    message.success(`已另存为「${name}」，运行中的档案未改变`);
    await refresh();
    loadForEdit(name);
    return true;
  } catch (e) {
    message.error((e as Error).message);
    return false;
  }
}

async function stopProfile() {
  dialog.warning({
    title: '停止当前设定档？',
    content: '将恢复为 default（默认曲线）',
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
  try {
    await bmcSend('DELETE', `settings/fanprofile/collection/${encodeURIComponent(name)}`);
    message.success(`已删除：${name}`);
    await refresh();
    loadForEdit(mode.value || profiles.value[0]?.strName || null);
  } catch (e) {
    message.error((e as Error).message);
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
  if (name === selectedName.value) return;
  if (dirty.value) {
    dialog.warning({
      title: '有未保存的修改',
      content: '切换将丢弃修改，继续？',
      positiveText: '丢弃并切换',
      negativeText: '留在当前',
      onPositiveClick: () => loadForEdit(name),
    });
  } else {
    loadForEdit(name);
  }
}

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
      </n-alert>

      <n-card title="风扇设定档">
        <template #header-extra>
          <n-space>
            <n-select
              :value="selectedName || null"
              :options="profileOptions"
              placeholder="选择设定档"
              style="width: 220px"
              size="small"
              @update:value="onTabSelect"
            />
            <n-button size="small" @click="loadForEdit(null)">新建</n-button>
            <n-button size="small" :disabled="!selectedName" @click="playProfile(selectedName)">
              {{ isRunning ? '重新应用' : '应用' }}
            </n-button>
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
              <n-space align="center" :size="8">
                <span class="lbl">Policy Reference Table（Reference → Duty 曲线点，Slope 算法）</span>
                <template v-if="orderNonMonotonic">
                  <span class="warn">Reference 有回折：图表按排序后绘制，保存时自动重排</span>
                  <n-button size="tiny" tertiary @click="normalizeOrder(pol); markDirty()">立即重排</n-button>
                </template>
              </n-space>
              <n-space vertical size="small" style="margin-top: 8px">
                <n-space v-for="(_, i) in pol.arrRef" :key="i" align="center" :size="8">
                  <span class="pt">点 {{ i }}</span>
                  <n-input-number v-model:value="pol.arrRef[i]" size="small" style="width: 120px" @update:value="markDirty" />
                  <span>→</span>
                  <n-input-number v-model:value="pol.arrDuty[i]" size="small" style="width: 110px" :min="0" :max="100" @update:value="markDirty">
                    <template #suffix>%</template>
                  </n-input-number>
                  <n-button size="tiny" quaternary type="error" :disabled="pol.arrRef.length <= 1" @click="removePoint(i)">删除</n-button>
                </n-space>
                <n-space align="center" :size="8">
                  <span class="pt" />
                  <n-button
                    dashed
                    size="small"
                    style="width: 256px"
                    :disabled="pol.arrRef.length >= MAX_REFS"
                    @click="addPoint"
                  >
                    ＋ 添加数据点（{{ pol.arrRef.length }}/{{ MAX_REFS }}）
                  </n-button>
                </n-space>
              </n-space>
            </div>

            <n-space align="center" :size="16">
              <span class="lbl">执行条件</span>
              <n-checkbox :checked="pol.iCpuTdp > 0" @update:checked="(v: boolean) => { pol.iCpuTdp = v ? (pol.iCpuTdp || 280) : 0; markDirty(); }">
                CPU TDP (W)
              </n-checkbox>
              <n-space v-if="pol.iCpuTdp > 0" align="center" :size="4">
                <span>&gt;</span>
                <n-input-number v-model:value="pol.iCpuTdp" size="small" style="width: 110px" :min="1" :max="255" @update:value="markDirty" />
                <span class="unit">W</span>
              </n-space>
              <n-checkbox :checked="pol.iAmbientSensor > 0" @update:checked="(v: boolean) => { pol.iAmbientSensor = v ? (pol.iAmbientSensor || tempSensorOptions[0]?.value || 0) : 0; if (v && pol.iAmbientSensorTemp === 0) pol.iAmbientSensorTemp = 40; markDirty(); }">
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
              <n-space v-if="pol.iAmbientSensor > 0" align="center" :size="4">
                <span>&gt;</span>
                <n-input-number v-model:value="pol.iAmbientSensorTemp" size="small" style="width: 100px" :min="0" :max="255" @update:value="markDirty" />
                <span class="unit">°C</span>
              </n-space>
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
              <n-button type="primary" :disabled="!dirty" @click="saveProfile">
                {{ sourceName === null ? '创建并保存' : '保存到 BMC' }}
              </n-button>
              <n-button :disabled="!editing" @click="openSaveAs">另存为…</n-button>
              <n-button :disabled="!dirty" @click="revert">还原</n-button>
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

    <n-modal
      v-model:show="showSaveAs"
      preset="dialog"
      title="另存为新档案"
      positive-text="保存为新档案"
      negative-text="取消"
      @positive-click="doSaveAs"
    >
      <n-space vertical size="small">
        <span style="color: #888; font-size: 12px">以当前编辑器内容创建一个新档案；原档案与运行中的档案都不受影响。</span>
        <n-input v-model:value="saveAsName" placeholder="新档案名称" @keyup.enter="doSaveAs" />
      </n-space>
    </n-modal>
  </n-spin>
</template>

<style scoped>
.lbl {
  color: #999;
  font-size: 12px;
}
.unit {
  color: #777;
  font-size: 12px;
}
.warn {
  color: #f0a020;
  font-size: 12px;
}
.pt {
  color: #777;
  font-size: 12px;
  width: 36px;
}
</style>
