// Redfish 增补数据的**后台预热器**。
//
// 起因（实测）：这台 BMC 的 Redfish 即使成功也要几十秒——/api/overview 直接等它，
// 结果 101 秒才回；/api/inventory 97 秒。而 UI 不能这么等。
//
// 所以改成「旁路刷新」模型：
//   · 请求路径**永不等 Redfish**，只用缓存里已有的增补数据（可能为空/略旧）；
//   · 本模块在后台按自己的节奏刷新增补数据（单会话、限速、熔断全在 RedfishClient 里）；
//   · 拿到了就更新缓存，前端下一次轮询自然就看到更丰富的字段。
//
// 这样即使 Redfish 完全挂死，UI 也只是少几个字段，绝不卡住。
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

export interface AugmentState {
  /** Redfish 的 Systems 成员（BIOS 版本/序列号/UUID/内存与 CPU 摘要/健康） */
  system: Record<string, unknown> | null;
  /** 按归一化名（去空格大写）索引的 Thermal 阈值 */
  thermal: Map<string, ThermalInfo>;
  firmware: FirmwareItem[];
  updatedAt: number;
  lastError: string;
  /** 已完成多少轮刷新 */
  rounds: number;
}

export const augment: AugmentState = {
  system: null,
  thermal: new Map(),
  firmware: [],
  updatedAt: 0,
  lastError: '',
  rounds: 0,
};

/** 后台刷新间隔：Redfish 慢，拉太长没必要（默认 90 秒） */
const INTERVAL_MS = Number(process.env.RF_AUGMENT_INTERVAL_MS || 90_000);
/** 启动后延迟多久开始第一轮（避免和用户登录、页面首屏抢资源） */
const FIRST_DELAY_MS = Number(process.env.RF_AUGMENT_FIRST_DELAY_MS || 4_000);

const FIRMWARE_TTL = Number(process.env.RF_FIRMWARE_TTL_MS || 30 * 60_000);
let firmwareAt = 0;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

async function refreshThermal() {
  const ch = await redfish.get<{ Members?: { '@odata.id': string }[] }>('/redfish/v1/Chassis', 300_000);
  const next = new Map<string, ThermalInfo>();
  for (const m of ch.Members ?? []) {
    const t = await redfish.get<{ Temperatures?: Record<string, unknown>[]; Fans?: Record<string, unknown>[] }>(
      `${m['@odata.id']}/Thermal`,
      120_000,
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

async function refreshSystem() {
  // 两条路都试：集合（标准做法）→ 集合里给出的成员；实测这台 BMC 的成员恒为 /Systems/Self，
  // 而集合本身偶发超时，所以集合失败时直接打成员路径（实测该路径稳定 200/2s）。
  let target = '/redfish/v1/Systems/Self';
  try {
    const coll = await redfish.get<{ Members?: { '@odata.id': string }[] }>('/redfish/v1/Systems', 300_000);
    target = coll.Members?.[0]?.['@odata.id'] ?? target;
  } catch {
    /* 集合拿不到就用已知成员路径 */
  }
  const sys = await redfish.get<Record<string, unknown>>(target, 180_000);
  augment.system = sys;
}

async function refreshFirmware() {
  const inv = await redfish.get<{ Members?: { '@odata.id': string }[] }>('/redfish/v1/UpdateService/FirmwareInventory', 600_000);
  const out: FirmwareItem[] = [];
  for (const m of inv.Members ?? []) {
    try {
      const d = await redfish.get<Record<string, unknown>>(m['@odata.id'], 600_000);
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
  firmwareAt = Date.now();
}

/** 一轮刷新：三块各自独立失败，互不影响 */
async function tick() {
  if (!redfish.available) {
    augment.lastError = '未配置凭据';
    return;
  }
  const errors: string[] = [];
  // 固件清单变化极慢（除非正在刷写），且它是三个里最慢的（1+每个组件一次请求），
  // 所以只在必要时刷新，避免每一轮都把时间耗在它上面。
  const firmwareDue = Date.now() - firmwareAt > FIRMWARE_TTL;
  const jobs = [
    ['system', refreshSystem],
    ['thermal', refreshThermal],
    ...(firmwareDue ? [['firmware', refreshFirmware] as const] : []),
  ] as const;
  for (const [label, fn] of jobs) {
    try {
      await fn();
    } catch (e) {
      errors.push(`${label}: ${(e as Error).message}`);
    }
  }
  augment.updatedAt = Date.now();
  augment.rounds++;
  augment.lastError = errors.join(' | ');
}

export function startAugmenter(log: (msg: string) => void): void {
  let stopped = false;
  const loop = async () => {
    if (stopped) return;
    const t0 = Date.now();
    await tick();
    const took = Math.round((Date.now() - t0) / 1000);
    if (augment.rounds === 1 || augment.lastError) {
      log(`Redfish 增补刷新 #${augment.rounds}：用时 ${took}s，系统信息=${augment.system ? '有' : '无'}，Thermal=${augment.thermal.size} 项，固件清单=${augment.firmware.length} 项${augment.lastError ? '，错误=' + augment.lastError : ''}`);
    }
    setTimeout(loop, INTERVAL_MS);
  };
  setTimeout(loop, FIRST_DELAY_MS);
  process.on('SIGINT', () => (stopped = true));
  process.on('SIGTERM', () => (stopped = true));
}
