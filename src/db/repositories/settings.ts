import type { Db } from "../connection.js";

interface SettingRecord { key: string; value: string }

/** Key-value store for runtime setting overrides. Absence of a key means "use the env default". */
export class SettingsRepo {
  constructor(private db: Db) {}

  /** All overrides as a plain object. */
  getAll(): Record<string, string> {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as unknown as SettingRecord[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  set(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(key, value, Date.now());
  }

  clear(key: string): void {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }
}
