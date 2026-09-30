// Redfish 增补数据的**后台预热器**。
//
// 为什么需要它（实测）：这台 BMC 的 Redfish 即使成功也要几秒到几十秒，单个资源偶尔还会挂住。
// 若让页面请求直接等它，/api/overview 会从 2 秒变成 101 秒。所以改成旁路刷新：
// 请求路径只读缓存，本模块在后台按自己的节奏把缓存填满。
//
// 三条设计要点（都是被"一直不就绪"这个问题逼出来的）：
//   1. **三块各自独立成循环**，不串在同一轮里。此前是一个 tick 里顺序 await 三个，
//      前面那个一挂（最长 90 秒），后面两个就一直等——用户看到的就是"永远不就绪"。
//   2. **登录后立刻踢一脚**（index.ts 调 kickAugmenter），不必等下一个周期。
//   3. **背景请求用较短超时**（45 秒）。用户可见的请求不能短超时（abort 会毒死 Redfish 会话），
//      但后台任务即使把会话弄脏也只影响自己——失败即换会话重登，代价可控，而挂着等 90 秒太贵。
import { redfish } from './redfish.js';

export interface ThermalInfo {
  name?: string;
  hnc?: number;
  hc?: number;
  lnc?: number;
  lc?: number;
}

export interface FirmwareItem {
  name: string;
  version: string;
  updateable: boolean | null;
  source: string;
}

/** 每个部分最近的执行结果（用于诊断"到底哪块没就绪"） */
export interface PartStatus {
  ok: boolean;
  at: number;
  err: string;
  attempts: number;
}

export interface AugmentState {
  /** Redfish 的 Systems/Self（BIOS 版本/序列号/UUID/内存与 CPU 摘要/健康） */
  system: Record<string, unknown> | null;
  /** 按归一化名（去空格大写）索引的 Thermal 阈值 */
  thermal: Map<string, ThermalInfo>;
  firmware: FirmwareItem[];
  parts: Record<'system' | 'thermal' | 'firmware', PartStatus>;
  updatedAt: number;
  lastError: string;
  /** 三个部分都成功过一次才算一轮完成 */
  rounds: number;
}

export const augment: AugmentState = {
  system: null,
  thermal: new Map(),
  firmware: [],
  parts: {
    system: { ok: false, at: 0, err: '', attempts: 0 },
    thermal: { ok: false, at: 0, err: '', attempts: 0 },
    firmware: { ok: false, at: 0, err: '', attempts: 0 },
  },
  updatedAt: 0,
  lastError: '',
  rounds: 0,
};

/** 后台任务的单请求超时（见文件顶部第 3 条） */
const BG_TIMEOUT_MS = Number(process.env.RF_BG_TIMEOUT_MS || 45_000);
/** 某部分失败后多久重试（比成功后的完整周期短得多）：
 *  实测 /Chassis/Self/Thermal 时好时坏（要聚合 18 个板载传感器，偶尔挂死），
 *  按 120 秒周期等的话"就绪"会拖很久。*/
const FAIL_RETRY_MS = Number(process.env.RF_FAIL_RETRY_MS || 30_000);
/** 各部分的刷新周期 */
const INTERVALS = {
  system: Number(process.env.RF_AUGMENT_INTERVAL_MS || 90_000),
  thermal: Number(process.env.RF_THERMAL_INTERVAL_MS || 120_000),
  // 固件清单变化极慢（除非正在刷写），且它是三者里最花请求的，周期拉长
  firmware: Number(process.env.RF_FIRMWARE_INTERVAL_MS || 30 * 60_000),
};

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

// ------------------------------------------------------------------ 三块的具体逻辑

/** 系统身份。直接打已知成员路径（实测 /Systems/Self 稳定 200/2s），集合只作兜底。 */
async function refreshSystem(): Promise<void> {
  let sys: Record<string, unknown>;
  try {
    sys = await redfish.get<Record<string, unknown>>('/redfish/v1/Systems/Self', 0, BG_TIMEOUT_MS);
  } catch {
    const coll = await redfish.get<{ Members?: { '@odata.id': string }[] }>('/redfish/v1/Systems', 0, BG_TIMEOUT_MS);
    const target = coll.Members?.[0]?.['@odata.id'];
    if (!target) throw new Error('Systems 集合没有成员');
    sys = await redfish.get<Record<string, unknown>>(target, 0, BG_TIMEOUT_MS);
  }
  augment.system = sys;
}

/** 发现过的 chassis 成员（首轮从集合拿，之后直接用，省一次可能挂起的请求） */
let chassisMembers: string[] = [];

async function refreshThermal(): Promise<void> {
  if (chassisMembers.length === 0) {
    const coll = await redfish.get<{ Members?: { '@odata.id': string }[] }>('/redfish/v1/Chassis', 0, BG_TIMEOUT_MS);
    chassisMembers = (coll.Members ?? []).map((m) => m['@odata.id']).filter(Boolean);
  }
  const next = new Map<string, ThermalInfo>();
  for (const uri of chassisMembers) {
    const t = await redfish.get<{ Temperatures?: Record<string, unknown>[]; Fans?: Record<string, unknown>[] }>(
      `${uri}/Thermal`,
      0,
      BG_TIMEOUT_MS,
    );
    for (const x of [...(t.Temperatures ?? []), ...(t.Fans ?? [])]) {
      const key = String(x.Name ?? x.MemberId ?? '').replace(/\s+/g, '').toUpperCase();
      if (!key) continue;
      next.set(key, {
        name: x.Name as string | undefined,
        hnc: num(x.UpperThresholdNonCritical),
        hc: num(x.UpperThresholdCritical),
        lnc: num(x.LowerThresholdNonCritical),
        lc: num(x.LowerThresholdCritical),
      });
    }
  }
  if (next.size > 0) augment.thermal = next;
}

async function refreshFirmware(): Promise<void> {
  const inv = await redfish.get<{ Members?: { '@odata.id': string }[] }>(
    '/redfish/v1/UpdateService/FirmwareInventory',
    0,
    BG_TIMEOUT_MS,
  );
  const out: FirmwareItem[] = [];
  for (const m of inv.Members ?? []) {
    try {
      const d = await redfish.get<Record<string, unknown>>(m['@odata.id'], 0, BG_TIMEOUT_MS);
      out.push({
        name: String(d.Name ?? m['@odata.id'].split('/').pop()),
        version: String(d.Version ?? ''),
        updateable: typeof d.Updateable === 'boolean' ? (d.Updateable as boolean) : null,
        source: 'redfish',
      });
    } catch {
      /* 单个组件失败忽略 */
    }
  }
  if (out.length) augment.firmware = out;
}

// ------------------------------------------------------------------ 独立循环

interface Part {
  key: keyof AugmentState['parts'];
  fn: () => Promise<void>;
  interval: number;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
}

const parts: Part[] = [
  { key: 'system', fn: refreshSystem, interval: INTERVALS.system, timer: null, running: false },
  { key: 'thermal', fn: refreshThermal, interval: INTERVALS.thermal, timer: null, running: false },
  { key: 'firmware', fn: refreshFirmware, interval: INTERVALS.firmware, timer: null, running: false },
];

let logger: ((msg: string) => void) | null = null;
let stopped = false;

function refreshLastError(): void {
  augment.lastError = Object.values(augment.parts)
    .map((x) => x.err)
    .filter(Boolean)
    .join(' | ');
}

async function runPart(p: Part): Promise<void> {
  if (stopped) return;
  if (p.running) return; // 上一轮还没跑完（慢），本轮跳过
  if (!redfish.available) {
    // 还没登录：静默等待。登录时 kickAugmenter() 会立刻把我们叫起来。
    p.timer = setTimeout(() => void runPart(p), 5_000);
    return;
  }
  p.running = true;
  const t0 = Date.now();
  const st = augment.parts[p.key];
  st.attempts++;
  try {
    await p.fn();
    st.ok = true;
    st.err = '';
    st.at = Date.now();
    augment.updatedAt = Date.now();
    refreshLastError();
    if (Object.values(augment.parts).every((x) => x.ok)) augment.rounds++;
    logger?.(`Redfish 增补「${p.key}」就绪（用时 ${Math.round((Date.now() - t0) / 1000)}s）`);
  } catch (e) {
    st.ok = false;
    st.err = (e as Error).message;
    st.at = Date.now();
    refreshLastError();
    logger?.(`Redfish 增补「${p.key}」失败（${Math.round((Date.now() - t0) / 1000)}s）：${st.err}`);
  } finally {
    p.running = false;
    const nextDelay = st.ok ? p.interval : Math.min(FAIL_RETRY_MS, p.interval);
    if (!stopped) p.timer = setTimeout(() => void runPart(p), nextDelay);
  }
}

/** 立刻跑一轮（登录成功后调用；已在跑的部分会被跳过） */
export function kickAugmenter(): void {
  for (const p of parts) {
    if (p.running) continue;
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => void runPart(p), 0);
  }
}

export function startAugmenter(log: (msg: string) => void): void {
  logger = log;
  // 三块错开一点起步，避免同时挤进 Redfish 的串行队列
  parts.forEach((p, i) => {
    p.timer = setTimeout(() => void runPart(p), i * 800);
  });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => (stopped = true));
}
