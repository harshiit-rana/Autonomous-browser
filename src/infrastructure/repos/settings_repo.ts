import type { AegisDb } from '../db.js';

/** Key/value JSON settings. All SQL for the `settings` table lives here. */
export class SettingsRepo {
  constructor(private readonly db: AegisDb) {}

  get<T = unknown>(key: string): T | undefined {
    return this.db.guard(() => {
      const row = this.db.handle.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
      return row ? (JSON.parse(row.value) as T) : undefined;
    });
  }

  set(key: string, value: unknown, now: number = Date.now()): void {
    this.db.guard(() => {
      this.db.handle
        .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
        .run(key, JSON.stringify(value), now);
    });
  }

  setMany(entries: Record<string, unknown>, now: number = Date.now()): void {
    this.db.tx(() => {
      for (const [k, v] of Object.entries(entries)) this.set(k, v, now);
    });
  }

  all(): Record<string, unknown> {
    return this.db.guard(() => {
      const rows = this.db.handle.prepare('SELECT key, value FROM settings ORDER BY key').all() as Array<{ key: string; value: string }>;
      const out: Record<string, unknown> = {};
      for (const r of rows) out[r.key] = JSON.parse(r.value);
      return out;
    });
  }

  delete(key: string): boolean {
    return this.db.guard(() => this.db.handle.prepare('DELETE FROM settings WHERE key = ?').run(key).changes > 0);
  }
}
