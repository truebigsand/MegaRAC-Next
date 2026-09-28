import type { BmcClient } from '../bmc.js';
import type { HistorySample, HistoryStore } from './types.js';

/** 可采样的单位（全部数值型，排除 unknown/Percent 里非数值的场景由调用侧过滤） */
const SAMPLABLE_UNITS = new Set(['deg_c', 'rpm', 'volts', 'amps', 'watts', 'percent']);

export interface SensorRow {
  name: string;
  reading: number;
  unit: string;
}

/**
 * 历史采样器：借用某个已登录浏览器会话的 BMC 客户端周期采样传感器读数。
 * 没有任何登录会话时跳过本轮（凭证不落盘，因此无登录就没有采样）。
 */
export class HistorySampler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPrune = 0;

  constructor(
    private readonly store: HistoryStore,
    private readonly intervalMs = 30_000,
    private readonly retentionMs = 30 * 24 * 3600 * 1000,
  ) {}

  start(getClient: () => BmcClient | null): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick(getClient).catch(() => {});
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(getClient: () => BmcClient | null): Promise<void> {
    const client = getClient();
    if (!client) return;
    const res = await client.get('/api/sensors');
    if (res.status !== 200 || !Array.isArray(res.body)) return;
    const rows = res.body as SensorRow[];
    const now = Date.now();
    const samples: HistorySample[] = rows
      .filter((s) => SAMPLABLE_UNITS.has(String(s.unit).toLowerCase()) && typeof s.reading === 'number')
      .map((s) => ({ sensor: s.name, ts: now, value: s.reading }));
    await this.store.append(samples);

    // 每天清理一次过期数据
    if (now - this.lastPrune > 24 * 3600 * 1000) {
      this.lastPrune = now;
      await this.store.prune(now - this.retentionMs);
    }
  }
}
