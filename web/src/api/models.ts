// 归一化模型的类型定义——与 server/src/models.ts 一一对应。
// 页面只依赖这些类型，不再各自解析 BMC 的裸字段。

export type SensorKind = 'temperature' | 'voltage' | 'fan' | 'power' | 'status' | 'other';
export type Health = 'ok' | 'warn' | 'crit' | 'na';

/** 增补数据的新鲜度（Redfish 侧的附加信息是后台预热来的） */
export interface AugmentInfo {
  available: boolean;
  updatedAt: number;
  ageSec: number | null;
  rounds: number;
  lastError: string;
}

export interface Sensor {
  id: number;
  name: string;
  type: string;
  kind: SensorKind;
  value: number | null;
  unit: string;
  health: Health;
  thresholds: { lnc?: number; lc?: number; hnc?: number; hc?: number };
  redfish?: { name?: string; hnc?: number; hc?: number; lnc?: number; lc?: number };
}

export interface SensorSnapshot {
  sensors: Sensor[];
  counts: { total: number; ok: number; warn: number; crit: number; na: number };
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

export interface Inventory {
  fru: {
    id: number;
    name: string;
    type: string;
    board: Record<string, string>;
    product: Record<string, string>;
  }[];
  firmware: { name: string; version: string; updateable: boolean | null; source: string }[];
  accounts: { name: string; privilege: string; enabled: boolean; channel: string }[];
  network: {
    interface: string;
    mac: string;
    ipv4: string;
    subnet: string;
    gateway: string;
    dhcp: boolean;
    ipv6: string;
  } | null;
  sources: { classic: boolean; redfish: boolean; redfishReason: string; augment: AugmentInfo };
}
