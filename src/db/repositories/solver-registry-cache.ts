import type { Db } from "../connection.js";
import type { SolverRegistryCacheRow } from "../types.js";

interface Row {
  url: string;
  network: string;
  body: string;
  fetched_at: number;
}

export class SolverRegistryCacheRepo {
  constructor(private db: Db) {}

  get(url: string, network: string): SolverRegistryCacheRow | undefined {
    const row = this.db.prepare("SELECT * FROM solver_registry_cache WHERE url = ? AND network = ?")
      .get(url, network) as unknown as Row | undefined;
    return row ? { url: row.url, network: row.network, body: row.body, fetchedAt: row.fetched_at } : undefined;
  }

  put(entry: SolverRegistryCacheRow): void {
    this.db.prepare(
      `INSERT INTO solver_registry_cache (url, network, body, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(url, network) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at`,
    ).run(entry.url, entry.network, entry.body, entry.fetchedAt);
  }
}
