import type { Db } from "../connection.js";
import type { BlacklistRow } from "../types.js";

interface BlacklistRecord {
  id: number;
  domain_id: number | null;
  username: string;
  reason: string | null;
  created_at: number;
}

function rowTo(r: BlacklistRecord): BlacklistRow {
  return { id: r.id, domainId: r.domain_id, username: r.username, reason: r.reason, createdAt: r.created_at };
}

export class BlacklistRepo {
  constructor(private db: Db) {}

  add(p: { domainId: number | null; username: string; reason?: string }): BlacklistRow {
    const info = this.db
      .prepare("INSERT INTO blacklist (domain_id, username, reason, created_at) VALUES (?, ?, ?, ?)")
      .run(p.domainId ?? null, p.username.toLowerCase(), p.reason ?? null, Date.now());
    const r = this.db.prepare("SELECT * FROM blacklist WHERE id = ?").get(Number(info.lastInsertRowid)) as unknown as BlacklistRecord;
    return rowTo(r);
  }

  /** True if the username is globally blacklisted or blacklisted for this domain. */
  isBlocked(domainId: number, username: string): boolean {
    const r = this.db
      .prepare(
        "SELECT 1 AS hit FROM blacklist WHERE username = ? AND (domain_id IS NULL OR domain_id = ?) LIMIT 1",
      )
      .get(username.toLowerCase(), domainId) as { hit: number } | undefined;
    return r != null;
  }

  list(domainId: number | null): BlacklistRow[] {
    const rows =
      domainId == null
        ? (this.db.prepare("SELECT * FROM blacklist WHERE domain_id IS NULL ORDER BY username").all() as unknown as BlacklistRecord[])
        : (this.db.prepare("SELECT * FROM blacklist WHERE domain_id = ? ORDER BY username").all(domainId) as unknown as BlacklistRecord[]);
    return rows.map(rowTo);
  }

  remove(id: number): void {
    this.db.prepare("DELETE FROM blacklist WHERE id = ?").run(id);
  }
}
