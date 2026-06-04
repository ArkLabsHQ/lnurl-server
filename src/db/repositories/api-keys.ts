import { randomBytes } from "node:crypto";
import type { Db } from "../connection.js";
import { hashSecret } from "../../crypto.js";

export interface ApiKeyRow {
  id: number;
  label: string | null;
  domainId: number | null;
  status: "active" | "revoked";
  createdAt: number;
  lastUsedAt: number | null;
}

interface ApiKeyRecord {
  id: number;
  label: string | null;
  domain_id: number | null;
  status: string;
  created_at: number;
  last_used_at: number | null;
}

function rowTo(r: ApiKeyRecord): ApiKeyRow {
  return { id: r.id, label: r.label, domainId: r.domain_id, status: r.status as ApiKeyRow["status"], createdAt: r.created_at, lastUsedAt: r.last_used_at };
}

export class ApiKeysRepo {
  constructor(private db: Db) {}

  /** Create a key; returns the raw value ONCE (only the hash is stored). */
  create(p: { label?: string; domainId?: number | null }): { id: number; raw: string; row: ApiKeyRow } {
    const raw = randomBytes(32).toString("hex");
    const info = this.db
      .prepare("INSERT INTO api_keys (key_hash, label, domain_id, status, created_at) VALUES (?, ?, ?, 'active', ?)")
      .run(hashSecret(raw), p.label ?? null, p.domainId ?? null, Date.now());
    const id = Number(info.lastInsertRowid);
    return { id, raw, row: this.getById(id)! };
  }

  getById(id: number): ApiKeyRow | undefined {
    const r = this.db.prepare("SELECT * FROM api_keys WHERE id = ?").get(id) as ApiKeyRecord | undefined;
    return r ? rowTo(r) : undefined;
  }

  /** Verify a raw key is active and valid for the domain (global or domain-scoped); touches last_used_at. */
  verify(raw: string, domainId: number): boolean {
    const r = this.db.prepare("SELECT * FROM api_keys WHERE key_hash = ?").get(hashSecret(raw)) as ApiKeyRecord | undefined;
    if (!r || r.status !== "active") return false;
    if (r.domain_id !== null && r.domain_id !== domainId) return false;
    this.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(Date.now(), r.id);
    return true;
  }

  list(): ApiKeyRow[] {
    const rows = this.db.prepare("SELECT * FROM api_keys ORDER BY created_at DESC").all() as unknown as ApiKeyRecord[];
    return rows.map(rowTo);
  }

  revoke(id: number): void {
    this.db.prepare("UPDATE api_keys SET status = 'revoked' WHERE id = ?").run(id);
  }
}
