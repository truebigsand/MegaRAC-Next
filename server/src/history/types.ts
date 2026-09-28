export interface HistorySample {
  sensor: string;
  ts: number;
  value: number;
}

export interface HistoryPoint {
  ts: number;
  value: number;
}

/**
 * 传感器历史存储接口。默认实现为 SQLite（node:sqlite）；
 * 后续可扩展 InfluxDB/Postgres 等实现，业务代码不感知具体存储。
 */
export interface HistoryStore {
  init(): Promise<void>;
  append(samples: HistorySample[]): Promise<void>;
  query(sensor: string, sinceMs: number, untilMs?: number): Promise<HistoryPoint[]>;
  /** 有数据的传感器名列表 */
  sensors(): Promise<string[]>;
  /** 清理早于 cutoffMs 的数据 */
  prune(cutoffMs: number): Promise<number>;
  close(): Promise<void>;
}
