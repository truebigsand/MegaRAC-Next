// 归一化模型层：把「经典 web API（骨干）」与「Redfish（增补）」的数据揉成 UI 直接可用的形状。
//
// 为什么要有这一层：
//   · 经典 API 的形状是逆向出来的、字段名很"裸机"（reading / sensor_state / unit / event_description…），
//     直接丢给前端会让每个页面都自己写一遍解析；
//   · Redfish 的形状是标准的，但在这台 BMC 上**部分资源会挂**（Chassis 实测挂满 120 秒），
//     所以只能"有则更好、无则回退"；
//   · 前端需要知道「这条数据是从哪来的、是否降级」，否则 BMC 一慢用户就只看到空白。
//
// 原则：**任何 Redfish 失败都不允许影响主干数据**——主干全部来自经典 API，
// Redfish 只做增补（BIOS 版本、序列号、内存/CPU 摘要、健康状态、标准阈值）。
import type { BmcClient } from './bmc.js';
import { redfish } from './redfish.js';
import { augment } from './augment.js';

export type SensorKind = 'temperature' | 'voltage' | 'fan' | 'power' | 'status' | 'other';
export type Health = 'ok' | 'warn' | 'crit' | 'na';

/** 增补数据的新鲜度信息（前端用来显示"增强数据更新于 xx 秒前"） */
export interface AugmentInfo {
  available: boolean;
  updatedAt: number;
  ageSec: number | null;
  rounds: number;
  lastError: string;
  /** 三部分各自的就绪状态——比"完成过几轮"更能说明当前能看到什么 */
  parts: { system: boolean; thermal: boolean; firmware: boolean };
  redfish: ReturnType<typeof redfish.stat>;
}

/** 把 Redfish 客户端内部的英文状态码翻成人话，别让它直接漏到界面上 */
function reasonText(reason: string): string {
  if (!reason || reason === 'idle') return '尚未开始';
  if (reason === 'ok') return '正常';
  if (reason.startsWith('redfish_not_configured')) return '未配置凭据';
  if (reason.startsWith('redfish_no_session')) return '会话建立失败';
  if (reason.startsWith('redfish_abuse_backoff') || reason.includes('防滥用')) return 'BMC 正在限制请求频率（约几分钟后自愈）';
  if (reason.startsWith('redfish_denied')) return '会话被 BMC 拒绝（已自动换会话）';
  if (reason.startsWith('redfish_broken')) return '该资源已熔断（多次失败后暂停访问）';
  if (reason.includes('熔断')) return '该资源多次失败已暂时熔断';
  if (reason.startsWith('请求异常')) return '请求超时或中断';
  return reason.length > 60 ? reason.slice(0, 60) + '…' : reason;
}

const augmentInfo = (redfishUsed: boolean): AugmentInfo => ({
  available: redfishUsed,
  updatedAt: augment.updatedAt,
  ageSec: augment.updatedAt ? Math.round((Date.now() - augment.updatedAt) / 1000) : null,
  rounds: augment.rounds,
  lastError: augment.lastError,
  parts: {
    system: augment.parts.system.ok,
    thermal: augment.parts.thermal.ok,
    firmware: augment.parts.firmware.ok,
  },
  redfish: redfish.stat(),
});

export interface Sensor {
  id: number;
  name: string;
  type: string;
  kind: SensorKind;
  value: number | null;
  unit: string;
  health: Health;
  thresholds: { lnc?: number; lc?: number; hnc?: number; hc?: number };
  /** 来自 Redfish Thermal 的补充（经典 API 没给的物理名/阈值） */
  redfish?: { name?: string; hnc?: number; hc?: number; lnc?: number; lc?: number };
}

export interface SensorSnapshot {
  sensors: Sensor[];
  counts: { total: number; ok: number; warn: number; crit: number; na: number };
  /** 数据来源与降级信息（前端用于提示） */
  sources: { classic: boolean; redfishThermal: boolean; augment: AugmentInfo };
  at: number;
}

export interface Overview {
  firmware: { version: string; buildDate: string; activeImage: number | null; skuVer?: string };
  system: {
    model: string;
    serial: string;
    uuid: string;
    biosVersion: string;
    manufacturer: string;
    powerState: 'on' | 'off';
    health: string;
    memorySummary?: string;
    cpuSummary?: string;
  };
  uptimeHours: number | null;
  fanMode: string;
  sessions: number;
  sensors: SensorSnapshot['counts'];
  hottest: { name: string; value: number }[];
  fans: { name: string; rpm: number }[];
  sources: {
    classic: boolean;
    redfish: boolean;
    redfishReason: string;
    /** 明确列出哪些字段是降级拿到的（空数组=全部来自首选源） */
    degraded: string[];
    augment: AugmentInfo;
  };
  at: number;
}

export interface SelEntry {
  id: number;
  time: string;
  timestamp: number;
  severity: 'info' | 'warn' | 'crit';
  direction: string;
  sensor: string;
  sensorType: string;
  message: string;
}

/**
 * 系统清单（只读）。
 *
 * ⚠️ 刻意**不含**账户与网络：那两项在「设置」页可写，放在这里会与设置页重复
 * （用户反馈过重复问题）。本页只放"看"的东西：固件组件、系统身份、FRU。
 */
export interface Inventory {
  system: {
    model: string;
    serial: string;
    uuid: string;
    biosVersion: string;
    manufacturer: string;
    cpuSummary: string;
    memorySummary: string;
    health: string;
    powerState: 'on' | 'off';
  };
  fru: { id: number; name: string; type: string; board: Record<string, string>; product: Record<string, string> }[];
  firmware: { name: string; version: string; updateable: boolean | null; source: string }[];
  sources: { classic: boolean; redfish: boolean; redfishReason: string; augment: AugmentInfo };
}

// ---------------------------------------------------------------- 工具

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function kindOf(s: { name?: string; type?: string }): SensorKind {
  const t = String(s.type ?? '').toLowerCase();
  if (t === 'temperature') return 'temperature';
  if (t === 'voltage') return 'voltage';
  if (t === 'fan') return 'fan';
  if (t === 'power_supply' || t === 'current') return 'power';
  // 非数值类：SEL、CPU0_Status、PS1_Status、SYS_POWER、Watchdog 等
  if (t === 'processor' || t === 'event_logging_disabled' || /status|watchdog|^sel$/i.test(t)) return 'status';
  const n = String(s.name ?? '');
  if (/FAN/i.test(n)) return 'fan';
  if (/TEMP/i.test(n)) return 'temperature';
  if (/^P_|VDD|VOUT|VBAT/i.test(n)) return 'voltage';
  return 'other';
}

/**
 * 判定健康度。以 BMC 自己给的 `sensor_state` 为权威，阈值只用来"加重"。
 *
 * 为什么不能只看阈值（实测踩过）：这台机器只有 1 条内存（Group 0）、SYS_FAN5 是空的、
 * 电源是普通 ATX（无 PMBus），所以 DIMMG1_TEMP / SYS_FAN5 / PSU*_HOTSPOT 读数恒为 0，
 * 而它们的下限阈值分别是 0 / 150 / 0 —— 纯按阈值判会得到一堆假"严重告警"。
 * BMC 自己对这 31 个模拟量的判断都是 sensor_state=1（正常），
 * 另外 5 个离散量（CPU0_Status / PS*_Status / SEL / Watchdog）是 sensor_state=0（不适用）。
 */
function healthOf(s: Record<string, unknown>, value: number | null, kind: SensorKind): Health {
  if (kind === 'status') return 'na';
  const state = num(s.sensor_state);
  if (state === 0) return 'na';
  if (value === null) return 'na';
  // 0 读数 = 未安装/无读数（温度与转速都如此），不是"零度/停转"
  if (value === 0 && (kind === 'temperature' || kind === 'fan')) return 'na';
  const hc = num(s.higher_critical_threshold);
  const hnc = num(s.higher_non_critical_threshold);
  const lc = num(s.lower_critical_threshold);
  const lnc = num(s.lower_non_critical_threshold);
  if (hc !== null && hc > -100 && value >= hc) return 'crit';
  if (lc !== null && lc > -100 && value <= lc) return 'crit';
  if (hnc !== null && hnc > -100 && value >= hnc) return 'warn';
  if (lnc !== null && lnc > -100 && value <= lnc) return 'warn';
  return 'ok';
}

const thr = (s: Record<string, unknown>) => {
  const pick = (k: string) => {
    const v = num(s[k]);
    return v !== null && v > -100 ? v : undefined;
  };
  return { lnc: pick('lower_non_critical_threshold'), lc: pick('lower_critical_threshold'), hnc: pick('higher_non_critical_threshold'), hc: pick('higher_critical_threshold') };
};

// ---------------------------------------------------------------- Redfish 增补
//
// ⚠️ 这里**只读缓存**（augment，由 augment.ts 的后台预热器填充），不发请求。
// 原因：这台 BMC 的 Redfish 单次请求可能要几十秒，放在请求路径上会让
// /api/overview 拖到 100 秒（实测踩过）。宁可用略旧的增补数据，也不让 UI 卡住。

// ---------------------------------------------------------------- 对外 API

export async function buildSensorSnapshot(client: BmcClient): Promise<SensorSnapshot> {
  const res = await client.get('/api/sensors', true);
  const raw = (Array.isArray(res.body) ? res.body : []) as Record<string, unknown>[];
  const rf = augment.thermal;

  const sensors: Sensor[] = raw.map((s) => {
    const name = String(s.name ?? '');
    const kind = kindOf({ name, type: String(s.type ?? '') });
    const numeric = kind !== 'status';
    const value = numeric ? num(s.reading) : null;
    const health = healthOf(s, value, kind);
    const r = rf.get(name.replace(/\s+/g, '').toUpperCase());
    return {
      id: Number(s.id ?? 0),
      name,
      type: String(s.type ?? ''),
      kind,
      value,
      unit: String(s.unit ?? ''),
      health,
      thresholds: thr(s),
      ...(r ? { redfish: { name: r.name, hnc: r.hnc, hc: r.hc, lnc: r.lnc, lc: r.lc } } : {}),
    };
  });

  const counts = { total: sensors.length, ok: 0, warn: 0, crit: 0, na: 0 };
  for (const s of sensors) counts[s.health]++;
  return { sensors, counts, sources: { classic: true, redfishThermal: rf.size > 0, augment: augmentInfo(rf.size > 0) }, at: Date.now() };
}

export async function buildOverview(client: BmcClient): Promise<Overview> {
  const degraded: string[] = [];

  // --- 主干：经典 API（并发但都被 client 串行化） ---
  const [fwRes, chRes, upRes, modeRes, sesRes, sens] = await Promise.all([
    client.get('/api/maintenance/firmware-info', true),
    client.get('/api/chassis-status', true),
    client.get('/api/status/uptime', true).catch(() => ({ body: null }) as { body: unknown }),
    client.get('/api/settings/fanprofile/mode', true).catch(() => ({ body: null }) as { body: unknown }),
    client.get('/api/settings/service-sessions', true).catch(() => ({ body: null }) as { body: unknown }),
    buildSensorSnapshot(client).catch(() => null),
  ]);

  const fw = (fwRes.body ?? {}) as Record<string, unknown>;
  const ch = (chRes.body ?? {}) as Record<string, unknown>;
  const up = (upRes.body ?? {}) as Record<string, unknown>;
  const mode = (modeRes.body ?? {}) as Record<string, unknown>;

  // --- 增补：Redfish 的 Systems/Self（BIOS 版本、序列号、内存/CPU 摘要、健康）---
  // 只读后台缓存，绝不在这里发请求（见本文件顶部与 augment.ts 的说明）
  const rfSystem = augment.system;
  if (!rfSystem) {
    degraded.push(redfish.available ? 'BIOS/序列号/CPU 摘要（Redfish 增补尚未就绪或该资源不可用）' : 'Redfish 未配置');
  }

  const uptime =
    up.poh_counter_reading !== undefined && up.minutes_per_count !== undefined
      ? (Number(up.poh_counter_reading) * Number(up.minutes_per_count)) / 60
      : null;

  // ⚠️ 排除 DTS：AMD 的 DTS 是"距临界温度的余量"（越小越热），不是温度本身，
  // 混进"最热几处"会让人误以为 CPU 真有 69°C。
  const hottest = (sens?.sensors ?? [])
    .filter((s) => s.kind === 'temperature' && s.value !== null && !/DTS/i.test(s.name))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    .slice(0, 3)
    .map((s) => ({ name: s.name, value: s.value as number }));
  const fans = (sens?.sensors ?? [])
    .filter((s) => s.kind === 'fan' && s.value !== null && s.value > 0)
    .map((s) => ({ name: s.name, rpm: s.value as number }));

  const mem = (rfSystem?.Memory ?? null) as Record<string, unknown> | null;
  const proc = (rfSystem?.ProcessorSummary ?? null) as Record<string, unknown> | null;
  const st = (rfSystem?.Status ?? null) as Record<string, unknown> | null;

  return {
    firmware: {
      version: String(fw.fw_ver ?? ''),
      buildDate: String(fw.date ?? ''),
      activeImage: num(fw.active_image),
      ...(fw.sku_ver ? { skuVer: String(fw.sku_ver) } : {}),
    },
    system: {
      model: String(rfSystem?.Model ?? ''),
      serial: String(rfSystem?.SerialNumber ?? ''),
      uuid: String(rfSystem?.UUID ?? ''),
      biosVersion: String(rfSystem?.BiosVersion ?? fw.bios_ver ?? ''),
      manufacturer: String(rfSystem?.Manufacturer ?? 'GIGABYTE'),
      powerState: Number(ch.power_status) === 1 ? 'on' : 'off',
      health: String(st?.Health ?? ''),
      ...(mem?.TotalSystemMemoryGiB ? { memorySummary: `${mem.TotalSystemMemoryGiB} GiB` } : {}),
      ...(proc ? { cpuSummary: `${proc.Count ?? '?'} × ${proc.Model ?? '?'}` } : {}),
    },
    uptimeHours: uptime,
    fanMode: String(mode.strMode ?? ''),
    sessions: Array.isArray(sesRes.body) ? sesRes.body.length : 0,
    sensors: sens?.counts ?? { total: 0, ok: 0, warn: 0, crit: 0, na: 0 },
    hottest,
    fans,
    sources: { classic: true, redfish: !!rfSystem, redfishReason: reasonText(redfish.stat().reason), degraded, augment: augmentInfo(!!rfSystem) },
    at: Date.now(),
  };
}

export async function buildSel(client: BmcClient, limit = 100): Promise<{ entries: SelEntry[]; total: number }> {
  const res = await client.get('/api/logs/event?LASTEVENTID=0', true);
  const raw = (Array.isArray(res.body) ? res.body : []) as Record<string, unknown>[];
  const sev = (v: unknown): SelEntry['severity'] => {
    const n = Number(v);
    if (n >= 3) return 'crit';
    if (n === 2) return 'warn';
    return 'info';
  };
  const entries: SelEntry[] = raw
    .map((e) => ({
      id: Number(e.id ?? 0),
      timestamp: Number(e.timestamp ?? 0) * 1000,
      time: new Date(Number(e.timestamp ?? 0) * 1000).toISOString(),
      severity: sev(e.event_assertSeverity),
      direction: String(e.event_direction ?? ''),
      sensor: String(e.sensor_name ?? ''),
      sensorType: String(e.sensor_type ?? ''),
      message: String(e.event_description ?? ''),
    }))
    .sort((a, b) => b.timestamp - a.timestamp);
  return { entries: entries.slice(0, limit), total: entries.length };
}

export async function buildInventory(client: BmcClient): Promise<Inventory> {
  const [fruRes, chRes] = await Promise.all([
    client.get('/api/settings/fru', true).catch(() => ({ body: null }) as { body: unknown }),
    client.get('/api/chassis-status', true).catch(() => ({ body: null }) as { body: unknown }),
  ]);

  const fru = ((Array.isArray(fruRes.body) ? fruRes.body : []) as Record<string, unknown>[]).map((f) => {
    const board = (f.board ?? {}) as Record<string, string>;
    const product = (f.product ?? {}) as Record<string, string>;
    const chassis = (f.chassis ?? {}) as Record<string, string>;
    return {
      id: Number((f.device as Record<string, unknown>)?.id ?? 0),
      name: String((f.device as Record<string, unknown>)?.name ?? 'FRU'),
      type: String(chassis.type ?? ''),
      board: {
        manufacturer: String(board.manufacturer ?? board.mfg ?? ''),
        product: String(board.product_name ?? board.name ?? ''),
        serial: String(board.serial_number ?? ''),
        part: String(board.part_number ?? ''),
      },
      product: {
        manufacturer: String(product.manufacturer ?? ''),
        product: String(product.product_name ?? ''),
        serial: String(product.serial_number ?? ''),
        part: String(product.part_number ?? ''),
      },
    };
  });

  // 固件清单：优先用后台预热到的 Redfish 数据（BIOS/CPLD 版本只有它有），否则退回经典
  const firmware: Inventory['firmware'] = augment.firmware.length ? [...augment.firmware] : [];
  if (firmware.length === 0) {
    const fw = await client.get('/api/maintenance/firmware-info', true);
    const f = (fw.body ?? {}) as Record<string, unknown>;
    firmware.push({ name: 'BMC', version: String(f.fw_ver ?? ''), updateable: null, source: 'classic' });
  }

  // 系统身份摘要：Redfish 优先（BIOS/序列号/UUID/CPU/内存/健康只有它有），经典 API 兜底
  const rf = augment.system;
  const mem = (rf?.Memory ?? null) as Record<string, unknown> | null;
  const proc = (rf?.ProcessorSummary ?? null) as Record<string, unknown> | null;
  const st = (rf?.Status ?? null) as Record<string, unknown> | null;
  const mainFru = fru.find((f) => f.board.serial || f.product.serial);
  const ch = (chRes.body ?? {}) as Record<string, unknown>;
  const system: Inventory['system'] = {
    model: String(rf?.Model ?? mainFru?.board.product ?? ''),
    serial: String(rf?.SerialNumber ?? mainFru?.board.serial ?? mainFru?.product.serial ?? ''),
    uuid: String(rf?.UUID ?? ''),
    biosVersion: String(rf?.BiosVersion ?? ''),
    manufacturer: String(rf?.Manufacturer ?? mainFru?.board.manufacturer ?? ''),
    cpuSummary: proc ? `${proc.Count ?? '?'} × ${proc.Model ?? '?'}` : '',
    memorySummary: mem?.TotalSystemMemoryGiB ? `${mem.TotalSystemMemoryGiB} GiB` : '',
    health: String(st?.Health ?? ''),
    powerState: Number(ch.power_status) === 1 ? 'on' : 'off',
  };

  return {
    system,
    fru,
    firmware,
    sources: { classic: true, redfish: firmware.some((f) => f.source === 'redfish') || !!rf, redfishReason: reasonText(redfish.stat().reason), augment: augmentInfo(!!rf) },
  };
}
