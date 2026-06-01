import type { Db } from "../connection.js";
import type { AllocationMode, CreateDomainParams, DomainRow } from "../types.js";

interface DomainRecord {
  id: number;
  domain: string;
  allocation_modes: string;
  require_api_key: number;
  max_per_session: number | null;
  username_min_len: number;
  username_max_len: number;
  username_pattern: string;
  min_sendable: number | null;
  max_sendable: number | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

function rowToDomain(r: DomainRecord): DomainRow {
  return {
    id: r.id,
    domain: r.domain,
    allocationModes: JSON.parse(r.allocation_modes) as AllocationMode[],
    requireApiKey: r.require_api_key === 1,
    maxPerSession: r.max_per_session,
    usernameMinLen: r.username_min_len,
    usernameMaxLen: r.username_max_len,
    usernamePattern: r.username_pattern,
    minSendable: r.min_sendable,
    maxSendable: r.max_sendable,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class DomainsRepo {
  constructor(private db: Db) {}

  create(p: CreateDomainParams): DomainRow {
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO domains
           (domain, allocation_modes, require_api_key, max_per_session,
            username_min_len, username_max_len, username_pattern,
            min_sendable, max_sendable, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.domain.toLowerCase(),
        JSON.stringify(p.allocationModes),
        p.requireApiKey ? 1 : 0,
        p.maxPerSession ?? null,
        p.usernameMinLen ?? 1,
        p.usernameMaxLen ?? 32,
        p.usernamePattern ?? "a-z0-9._-",
        p.minSendable ?? null,
        p.maxSendable ?? null,
        p.enabled === false ? 0 : 1,
        now,
        now,
      );
    return this.getById(Number(info.lastInsertRowid))!;
  }

  getById(id: number): DomainRow | undefined {
    const r = this.db.prepare("SELECT * FROM domains WHERE id = ?").get(id) as DomainRecord | undefined;
    return r ? rowToDomain(r) : undefined;
  }

  getByDomain(domain: string): DomainRow | undefined {
    const r = this.db.prepare("SELECT * FROM domains WHERE domain = ?").get(domain.toLowerCase()) as
      | DomainRecord
      | undefined;
    return r ? rowToDomain(r) : undefined;
  }

  list(): DomainRow[] {
    const rows = this.db.prepare("SELECT * FROM domains ORDER BY domain").all() as unknown as DomainRecord[];
    return rows.map(rowToDomain);
  }

  update(id: number, patch: Partial<CreateDomainParams>): void {
    const current = this.getById(id);
    if (!current) throw new Error(`domain ${id} not found`);
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE domains SET
           allocation_modes = ?, require_api_key = ?, max_per_session = ?,
           username_min_len = ?, username_max_len = ?, username_pattern = ?,
           min_sendable = ?, max_sendable = ?, enabled = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        JSON.stringify(next.allocationModes),
        next.requireApiKey ? 1 : 0,
        next.maxPerSession ?? null,
        next.usernameMinLen,
        next.usernameMaxLen,
        next.usernamePattern,
        next.minSendable ?? null,
        next.maxSendable ?? null,
        next.enabled ? 1 : 0,
        Date.now(),
        id,
      );
  }

  delete(id: number): void {
    this.db.prepare("DELETE FROM domains WHERE id = ?").run(id);
  }
}
