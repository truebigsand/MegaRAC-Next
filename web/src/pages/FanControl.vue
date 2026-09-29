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
import { useIsMobile } from '../useMediaQuery';
import { useChartAutoResize } from '../useChartAutoResize';
import { CHART_COLORS, PREVIEW_PALETTE } from '../chartTheme';

const isMobile = useIsMobile();

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
    iPolicyType: pol.iPolicyType === ALGO_STEP ? ALGO_STEP : ALGO_SLOPE,
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
        iPolicyType: ALGO_SLOPE, iInSDR: 1, iSensorCode: 1, iInitDuty: 30,
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

/** 正在编辑的档案与运行档案传感器类别不同、未叠加对照曲线 */
const runCurveIncomparable = ref(false);

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
  // 传感器类别不同（温度余量 vs 真实温度）时两者刻度不同源，不能画在同一根轴上，
  // 否则会被横轴方向镜像成"越热越慢"的假象 —— 此时不叠加对照曲线并给出说明
  const sameKind = !!runPol && isDtsSource(pol) === isDtsSource(runPol);
  runCurveIncomparable.value = !!runPol && !isEditingRunning && !sameKind;
  const stepOpt = isStepAlgo(pol.iPolicyType) ? ({ step: 'end' } as const) : {};
  const series: echarts.SeriesOption[] = [
    {
      name: isEditingRunning ? '当前运行' : '编辑中',
      type: 'line',
      ...stepOpt,
      data: orderedPoints(pol),
      lineStyle: { color: CHART_COLORS.primary, width: 2 },
      itemStyle: { color: CHART_COLORS.primary },
      symbolSize: 8,
    },
  ];
  if (runPol && !isEditingRunning && sameKind) {
    series.push({
      name: `当前运行（${mode.value}）`,
      type: 'line',
      ...(isStepAlgo(runPol.iPolicyType) ? ({ step: 'end' } as const) : {}),
      data: orderedPoints(runPol),
      lineStyle: { color: CHART_COLORS.reference, type: 'dashed' },
      itemStyle: { color: CHART_COLORS.reference },
      symbolSize: 4,
    });
  }
  // AMD DTS 传感器读的是"距临界温度的余量"（Tcrit − 实际温度），越小越热。
  // 与原版一致：DTS 源时横轴反向（左冷右热），曲线才能读成"越热→越快"。
  const isDts = isDtsSource(pol);
  chart.setOption({
    animation: false,
    tooltip: { trigger: 'axis' },
    legend: { top: 0, textStyle: { color: CHART_COLORS.legendText, fontSize: 11 } },
    grid: { left: 50, right: 20, top: 36, bottom: 40 },
    xAxis: {
      type: 'value',
      inverse: isDts,
      name: isDts ? '温度余量（小=热）' : '传感器读值',
      nameLocation: 'middle',
      nameGap: 28,
      nameTextStyle: { color: CHART_COLORS.axisText },
      axisLabel: { color: CHART_COLORS.axisText },
    },
    yAxis: { type: 'value', name: 'Duty (%)', min: 0, max: 100, nameTextStyle: { color: CHART_COLORS.axisText }, axisLabel: { color: CHART_COLORS.axisText } },
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

// ---------- 曲线编辑器（预设曲线 → 取样为有限个数据点） ----------
type CurveShape = 'linear' | 'quiet' | 'standard' | 'aggressive' | 'smooth' | 'step';

const shapeOptions: { label: string; value: CurveShape }[] = [
  { label: '线性', value: 'linear' },
  { label: '安静（晚提速）', value: 'quiet' },
  { label: '标准', value: 'standard' },
  { label: '激进（早提速）', value: 'aggressive' },
  { label: 'S 形（两端平缓）', value: 'smooth' },
  { label: '阶梯', value: 'step' },
];

/** 归一化曲线：t∈[0,1] 为「凉端→热端」的位置，返回 0..1（占空比比例） */
function curveRatio(shape: CurveShape, t: number): number {
  const c = Math.min(1, Math.max(0, t));
  switch (shape) {
    case 'quiet':
      return Math.pow(c, 2.5);
    case 'standard':
      return Math.pow(c, 1.5);
    case 'aggressive':
      return Math.pow(c, 0.5);
    case 'smooth':
      return c * c * (3 - 2 * c);
    case 'step':
      return Math.min(1, Math.floor(c * 4) / 3);
    default:
      return c;
  }
}

/**
 * 生成「按参考点取值」的求值函数。
 * 算法来自档案字段 iPolicyType（原版 Algorithm 下拉框只有两项）：
 *   1 = Step  阶梯：读数在两参考点之间时保持前一参考点的占空比
 *   2 = Slope 斜率：相邻参考点之间线性插值
 * 两者都超出两端钳位。
 */
const ALGO_STEP = 1;
const ALGO_SLOPE = 2;
const algoOptions = [
  { label: 'Slope（斜率插值）', value: ALGO_SLOPE },
  { label: 'Step（阶梯保持）', value: ALGO_STEP },
];

function isStepAlgo(algo: number | undefined): boolean {
  return algo === ALGO_STEP;
}

function makeEvaluator(pairs: { ref: number; duty: number }[], algo: number | undefined): (x: number) => number {
  const seq = [...pairs].sort((a, b) => a.ref - b.ref);
  return (x: number): number => {
    if (seq.length === 0) return 0;
    if (seq.length === 1) return seq[0].duty;
    const first = seq[0];
    const last = seq[seq.length - 1];
    if (x <= first.ref) return first.duty;
    if (x >= last.ref) return last.duty;
    for (let i = 0; i < seq.length - 1; i++) {
      const a = seq[i];
      const b = seq[i + 1];
      if (x >= a.ref && x <= b.ref) {
        if (isStepAlgo(algo)) return a.duty;
        const span = b.ref - a.ref;
        return span === 0 ? a.duty : a.duty + ((b.duty - a.duty) * (x - a.ref)) / span;
      }
    }
    return last.duty;
  };
}

type AllocMode = 'uniform' | 'adaptive';
const allocOptions: { label: string; value: AllocMode }[] = [
  { label: '等距取点', value: 'uniform' },
  { label: '自动取点（陡处加密）', value: 'adaptive' },
];

/**
 * 在 t∈[0,1] 上分配 n 个取样位置（含两端）。
 * uniform：等距；adaptive：按曲线累积占空比变化量等分 —— 斜率越大处点越密，
 * 平缓段只保留端点；恒定曲线（总变化≈0）退回等距。
 */
function allocateTs(n: number, shape: CurveShape, dts: boolean, mode: AllocMode): number[] {
  const uniform = () => Array.from({ length: n }, (_, i) => (n === 1 ? 0 : i / (n - 1)));
  if (mode === 'uniform' || n <= 2) return uniform();

  const K = 240;
  const ys = Array.from({ length: K + 1 }, (_, k) => curveRatio(shape, dts ? 1 - k / K : k / K));
  const cum: number[] = [0];
  for (let k = 0; k < K; k++) cum.push(cum[k] + Math.abs(ys[k + 1] - ys[k]));
  const total = cum[K];
  if (!(total > 1e-6)) return uniform();

  const ts: number[] = [];
  let k = 0;
  for (let i = 0; i < n; i++) {
    const target = (total * i) / (n - 1);
    while (k < K && cum[k + 1] < target) k++;
    if (k >= K) {
      ts.push(1);
      continue;
    }
    const seg = cum[k + 1] - cum[k];
    ts.push((k + (seg > 0 ? (target - cum[k]) / seg : 0)) / K);
  }
  return ts;
}

const showCurveEditor = ref(false);const previewEl = ref<HTMLDivElement>();
let previewChart: echarts.ECharts | null = null;
const curveForm = ref<CurveForm>({
  shape: 'standard',
  allocate: 'uniform',
  samples: 6,
  x0: 40,
  x1: 85,
  y0: 30,
  y1: 100,
});

/** 曲线编辑器的表单参数（每次打开都由当前档案推导，不留隐藏状态） */
interface CurveForm {
  shape: CurveShape;
  allocate: AllocMode;
  samples: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

function openCurveEditor() {
  const pol0 = pol.value;
  if (!pol0) return;

  // 读数范围与占空比范围都取自当前档案的现有值
  const refs = pol0.arrRef.filter((r) => Number.isFinite(r));
  const duties = pol0.arrDuty.filter((d) => Number.isFinite(d));
  const dts = isDtsSource(pol0);
  const x0 = refs.length >= 2 ? Math.min(...refs) : dts ? 50 : 40;
  const x1 = refs.length >= 2 ? Math.max(...refs) : dts ? 10 : 85;
  let y0 = duties.length >= 1 ? Math.min(...duties) : 30;
  let y1 = duties.length >= 1 ? Math.max(...duties) : 100;
  // 档案占空比过于集中（如恒速档案全是 1%）时，给一个便于作图的起点范围
  if (y1 - y0 < 5) {
    y0 = 30;
    y1 = 100;
  }
  curveForm.value = {
    shape: 'standard',
    allocate: 'uniform',
    samples: Math.max(2, Math.min(MAX_REFS, refs.length || 6)),
    x0,
    x1,
    y0,
    y1,
  };
  showCurveEditor.value = true;
}

/** 按当前表单取样为 (读数, 占空比) 点集 */
function buildSamples(): { refs: number[]; duties: number[] } {
  const f = curveForm.value;
  const pol0 = pol.value;
  const dts = pol0 ? isDtsSource(pol0) : false;
  const n = Math.max(2, Math.min(MAX_REFS, Math.round(f.samples)));
  const refs: number[] = [];
  const duties: number[] = [];
  for (const t of allocateTs(n, f.shape, dts, f.allocate)) {
    const x = Math.round(f.x0 + (f.x1 - f.x0) * t);
    // DTS 是温度余量（越小越热），把曲线按「越热越快」的方向映射
    const y = Math.round(f.y0 + (f.y1 - f.y0) * curveRatio(f.shape, dts ? 1 - t : t));
    if (refs.length > 0 && refs[refs.length - 1] === x) continue; // 取整后重复的读数跳过
    refs.push(x);
    duties.push(Math.max(0, Math.min(100, y)));
  }
  return { refs, duties };
}

const samplePreview = computed(() => (showCurveEditor.value ? buildSamples() : { refs: [], duties: [] }));

function initPreview() {
  if (!previewEl.value) return;
  if (!previewChart) previewChart = echarts.init(previewEl.value);
  drawPreview();
}

function disposePreview() {
  previewChart?.dispose();
  previewChart = null;
}

function drawPreview() {
  if (!previewChart || !previewEl.value) return;
  const f = curveForm.value;
  const pol0 = pol.value;
  const dts = pol0 ? isDtsSource(pol0) : false;
  const span = f.x1 - f.x0;
  const ratioAt = (x: number) => {
    const t = span === 0 ? 0 : (x - f.x0) / span;
    return curveRatio(f.shape, dts ? 1 - t : t);
  };

  const s = buildSamples();
  // 与写入固件一致的顺序（升序；DTS 倒序）
  const pairs = s.refs.map((ref, i) => ({ ref, duty: s.duties[i] }));
  pairs.sort((a, b) => a.ref - b.ref);
  if (dts) pairs.reverse();

  /**
   * 取样点之间的取值按斜率线性插值（实测固件即如此：参考点之间线性插值，超出两端钳位）。
   * 读数与占空比都取整（固件的参考点/占空比本就是整数），两条系列共用同一组整数读数网格，
   * 铺满整段区间 —— 这样默认 tooltip 在任意位置都能同时命中两条系列，无需自定义 formatter。
   */
  const interpAt = makeEvaluator(pairs, pol0?.iPolicyType);
  const grid = 60;
  const xs = [
    ...new Set(
      Array.from({ length: grid + 1 }, (_, i) => Math.round(f.x0 + (span * i) / grid)).concat(pairs.map((p) => p.ref)),
    ),
  ].sort((a, b) => a - b);

  const targetData: [number, number][] = xs.map((x) => [x, Math.round(f.y0 + (f.y1 - f.y0) * ratioAt(x))]);
  const sampleSet = new Set(pairs.map((p) => p.ref));
  const actualData = xs.map((x) => ({
    value: [x, Math.round(interpAt(x))] as [number, number],
    // 只有真正的取样点显示标记，其余铺密点仅用于 tooltip 覆盖
    symbol: sampleSet.has(x) ? 'circle' : 'none',
    symbolSize: sampleSet.has(x) ? 7 : 0,
  }));

  previewChart.setOption(
    {
      animation: false,
      grid: { left: 46, right: 16, top: 26, bottom: 30 },
      legend: { top: 0, textStyle: { color: CHART_COLORS.legendTextCompact, fontSize: 10 }, itemWidth: 12, itemHeight: 8 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'line', snap: true } },
      xAxis: { type: 'value', name: dts ? '温度余量' : '传感器读数', nameTextStyle: { color: CHART_COLORS.axisText, fontSize: 10 }, axisLabel: { color: CHART_COLORS.axisText, fontSize: 10, formatter: (v: number) => String(Math.round(v)) }, inverse: dts },
      yAxis: { type: 'value', name: 'Duty (%)', min: 0, max: 100, nameTextStyle: { color: CHART_COLORS.axisText, fontSize: 10 }, axisLabel: { color: CHART_COLORS.axisText, fontSize: 10 } },
      series: [
        { name: '目标曲线', type: 'line', showSymbol: false, smooth: false, data: targetData, lineStyle: { color: CHART_COLORS.primary, width: 2 }, itemStyle: { color: CHART_COLORS.primary } },
        { name: '实际取值', type: 'line', data: actualData, lineStyle: { color: CHART_COLORS.sampled, width: 1, type: 'dashed' }, itemStyle: { color: CHART_COLORS.sampled } },
      ],
    },
    { notMerge: true },
  );
  previewChart.resize();
}

function applyCurve() {
  const p = editing.value?.arrPolicy[0];
  if (!p) return;
  const s = buildSamples();
  if (s.refs.length < 2) {
    message.warning('取样点不足，请增大取样点数或放宽读数范围');
    return;
  }
  p.arrRef = s.refs;
  p.arrDuty = s.duties;
  normalizeOrder(p);
  markDirty();
  showCurveEditor.value = false;
  message.success(`已填充 ${s.refs.length} 个数据点，确认后点「保存到 BMC」写入`);
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

useChartAutoResize(chartEl, () => chart);

onMounted(() => {
  chart = echarts.init(chartEl.value!);
  refresh();
  timer = setInterval(refresh, 15000);
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
          <n-space v-if="!isMobile">
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

        <!-- 窄屏：操作按钮下移到内容区，避免挤压卡片标题 -->
        <n-space v-if="isMobile" vertical size="small" style="margin-bottom: 12px">
          <n-select
            :value="selectedName || null"
            :options="profileOptions"
            placeholder="选择设定档"
            style="width: 100%"
            size="small"
            @update:value="onTabSelect"
          />
          <n-space :size="8">
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
        </n-space>

        <div ref="chartEl" :style="{ height: isMobile ? '240px' : '300px' }" />
        <p v-if="runCurveIncomparable" class="warn" style="margin: 8px 0 0">
          当前运行的档案使用不同类别的传感器（温度余量 vs 真实温度），刻度不同源、无法同轴比较，故未叠加显示。
        </p>

        <template v-if="editing && pol">
          <n-space vertical size="medium" style="margin-top: 16px">
            <!-- 窄屏：每项独占一行（标签等宽对齐），桌面端一行平铺 -->
            <div class="field-rows">
              <div class="field">
                <span class="lbl">设定档名称</span>
                <n-input class="ctrl" v-model:value="editing.strName" size="small" :style="isMobile ? undefined : 'width: 200px'" @update:value="markDirty" />
              </div>
              <div class="field">
                <span class="lbl">初始 Duty (%)</span>
                <n-input-number class="ctrl" v-model:value="pol.iInitDuty" size="small" :min="0" :max="100" @update:value="markDirty" />
              </div>
              <div class="field">
                <span class="lbl">滞回 iHysteresis</span>
                <n-input-number class="ctrl" v-model:value="pol.iHysteresis" size="small" :min="0" :max="100" @update:value="markDirty" />
              </div>
              <div class="field">
                <span class="lbl">算法</span>
                <n-select
                  class="ctrl"
                  v-model:value="pol.iPolicyType"
                  :options="algoOptions"
                  size="small"
                  :style="isMobile ? undefined : 'min-width: 170px'"
                  @update:value="markDirty"
                />
              </div>
            </div>

            <div class="field-rows">
              <div class="field">
                <span class="lbl">源传感器（温度）</span>
                <n-select
                  class="ctrl"
                  v-model:value="pol.arrSensor"
                  :options="tempSensorOptions"
                  multiple
                  size="small"
                  :style="isMobile ? undefined : 'min-width: 280px'"
                  placeholder="选择温度源"
                  @update:value="markDirty"
                />
              </div>
              <div class="field">
                <span class="lbl">被控风扇</span>
                <n-select
                  class="ctrl"
                  v-model:value="pol.arrFanSensor"
                  :options="fanSensorOptions"
                  multiple
                  size="small"
                  :style="isMobile ? undefined : 'min-width: 280px'"
                  placeholder="选择风扇"
                  @update:value="markDirty"
                />
              </div>
            </div>

            <div>
              <n-space align="center" :size="8">
                <span class="lbl">Policy Reference Table（Reference → Duty 曲线点，Slope 算法）</span>
                <n-button size="tiny" type="primary" secondary @click="openCurveEditor">曲线编辑器</n-button>
                <template v-if="orderNonMonotonic">
                  <span class="warn" :style="{ color: CHART_COLORS.sampled }">Reference 有回折：图表按排序后绘制，保存时自动重排</span>
                  <n-button size="tiny" tertiary @click="normalizeOrder(pol); markDirty()">立即重排</n-button>
                </template>
              </n-space>
              <n-space vertical size="small" style="margin-top: 8px">
                <n-space v-for="(_, i) in pol.arrRef" :key="i" align="center" :size="8">
                  <span class="pt">点 {{ i }}</span>
                  <n-input-number
                    v-model:value="pol.arrRef[i]"
                    size="small"
                    :show-button="!isMobile"
                    :style="isMobile ? 'width: 76px' : 'width: 120px'"
                    @update:value="markDirty"
                  />
                  <span>→</span>
                  <n-input-number
                    v-model:value="pol.arrDuty[i]"
                    size="small"
                    :show-button="!isMobile"
                    :style="isMobile ? 'width: 92px' : 'width: 110px'"
                    :min="0"
                    :max="100"
                    @update:value="markDirty"
                  >
                    <template #suffix>%</template>
                  </n-input-number>
                  <n-button size="tiny" quaternary type="error" :disabled="pol.arrRef.length <= 1" @click="removePoint(i)">删除</n-button>
                </n-space>
                <n-space align="center" :size="8">
                  <span class="pt" />
                  <n-button
                    dashed
                    size="small"
                    :style="isMobile ? 'width: 190px' : 'width: 256px'"
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
                :style="isMobile ? 'width: 100%' : 'width: 200px'"
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
              :style="isMobile ? 'width: 100%' : 'max-width: 500px'"
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

    <n-modal
      v-model:show="showCurveEditor"
      preset="card"
      title="曲线编辑器"
      style="width: min(680px, 94vw)"
      :on-after-enter="initPreview"
      :on-after-leave="disposePreview"
    >
      <n-space vertical size="medium">
        <div class="field-rows">
          <div class="field">
            <span class="lbl">曲线形状</span>
            <n-select
              class="ctrl"
              v-model:value="curveForm.shape"
              :options="shapeOptions"
              size="small"
              style="min-width: 170px"
              @update:value="drawPreview"
            />
          </div>
          <div class="field">
            <span class="lbl">取点方式</span>
            <n-select
              class="ctrl"
              v-model:value="curveForm.allocate"
              :options="allocOptions"
              size="small"
              style="min-width: 190px"
              @update:value="drawPreview"
            />
          </div>
          <div class="field">
            <span class="lbl">取样点数</span>
            <n-input-number
              v-model:value="curveForm.samples"
              size="small"
              :min="2"
              :max="MAX_REFS"
              style="width: 110px"
              @update:value="drawPreview"
            />
            <span class="unit">/ {{ MAX_REFS }}</span>
          </div>
        </div>

        <div class="field-rows">
          <div class="field">
            <span class="lbl">读数范围</span>
            <n-input-number v-model:value="curveForm.x0" size="small" style="width: 96px" @update:value="drawPreview" />
            <span>→</span>
            <n-input-number v-model:value="curveForm.x1" size="small" style="width: 96px" @update:value="drawPreview" />
          </div>
          <div class="field">
            <span class="lbl">占空比</span>
            <n-input-number v-model:value="curveForm.y0" size="small" :min="0" :max="100" style="width: 96px" @update:value="drawPreview" />
            <span>→</span>
            <n-input-number v-model:value="curveForm.y1" size="small" :min="0" :max="100" style="width: 96px" @update:value="drawPreview" />
          </div>
        </div>

        <div ref="previewEl" style="height: 220px" />

        <p class="dim" style="margin: 0">
          绿色为目标曲线，橙色虚线是按取样点还原的取值曲线（Slope 按斜率插值、Step 保持前一参考点）。<b>应用</b>后填充到「数据点」列表，确认无误再点「保存到 BMC」写入。
          <template v-if="pol && isDtsSource(pol)">源传感器为 DTS（温度余量），曲线方向已按「越热越快」自动映射。</template>
        </p>
      </n-space>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showCurveEditor = false">取消</n-button>
          <n-button type="primary" @click="applyCurve">应用（填充 {{ samplePreview.refs.length }} 个点）</n-button>
        </n-space>
      </template>
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
.dim {
  color: #8a8a8a;
  font-size: 12px;
  line-height: 1.6;
}
/* 字段行：桌面端一行平铺；窄屏每项独占一行、标签等宽对齐 */
.field-rows {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 16px;
}
.field {
  display: flex;
  align-items: center;
  gap: 12px;
}
/* 标签不参与压缩/换行：否则多个字段挤一行时会被压成竖排单字 */
.field > .lbl {
  flex: 0 0 auto;
  white-space: nowrap;
}
@media (max-width: 768px) {
  .field {
    flex: 1 1 100%;
  }
  .field > .lbl {
    flex: 0 0 112px;
  }
  /* basis 必须为 0：输入框默认宽度接近 100%，否则会整行换到下一行 */
  .field > .ctrl {
    flex: 1 1 0;
    min-width: 0;
  }
}
.warn {
  font-size: 12px;
}
.pt {
  color: #777;
  font-size: 12px;
  width: 36px;
}
</style>
