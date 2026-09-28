import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { HistoryPoint, HistorySample, HistoryStore } from './types.js';

export class SqliteHistoryStore implements HistoryStore {
  private db!: DatabaseSync;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
  }

  async init(): Promise<void> {
    this.db = new DatabaseSync(this.path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS samples (
        sensor TEXT NOT NULL,
        ts     INTEGER NOT NULL,
        value  REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_samples_sensor_ts ON samples (sensor, ts);
    `);
  }

  async append(samples: HistorySample[]): Promise<void> {
    if (samples.length === 0) return;
    const stmt = this.db.prepare('INSERT INTO samples (sensor, ts, value) VALUES (?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const s of samples) stmt.run(s.sensor, s.ts, s.value);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async query(sensor: string, sinceMs: number, untilMs = Date.now()): Promise<HistoryPoint[]> {
    const rows = this.db
      .prepare('SELECT ts, value FROM samples WHERE sensor = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC')
      .all(sensor, sinceMs, untilMs) as { ts: number; value: number }[];
    return rows;
  }

  async sensors(): Promise<string[]> {
    const rows = this.db.prepare('SELECT DISTINCT sensor FROM samples ORDER BY sensor').all() as { sensor: string }[];
    return rows.map((r) => r.sensor);
  }

  async prune(cutoffMs: number): Promise<number> {
    const res = this.db.prepare('DELETE FROM samples WHERE ts < ?').run(cutoffMs);
    return Number(res.changes);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
