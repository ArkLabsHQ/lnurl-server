import type { Db } from "../connection.js";
import type { EncryptedToken } from "../../crypto.js";
import type { AddressRow, AddressStatus, CreateAddressParams } from "../types.js";

interface AddressRecord {
  id: number;
  domain_id: number;
  username: string;
  session_id: string | null;
  token_ciphertext: Uint8Array | null;
  token_iv: Uint8Array | null;
  token_tag: Uint8Array | null;
  claim_code_hash: Uint8Array | null;
  status: string;
  metadata: string | null;
  arkade_address: string | null;
  claim_public_key: string | null;
  created_at: number;
  updated_at: number;
}

function buf(v: Uint8Array | null): Buffer | null {
  return v == null ? null : Buffer.from(v);
}

function rowToAddress(r: AddressRecord): AddressRow {
  const enc: EncryptedToken | null =
    r.token_ciphertext && r.token_iv && r.token_tag
      ? { ciphertext: Buffer.from(r.token_ciphertext), iv: Buffer.from(r.token_iv), tag: Buffer.from(r.token_tag) }
      : null;
  return {
    id: r.id,
    domainId: r.domain_id,
    username: r.username,
    sessionId: r.session_id,
    encryptedToken: enc,
    claimCodeHash: buf(r.claim_code_hash),
    status: r.status as AddressStatus,
    metadata: r.metadata,
    arkadeAddress: r.arkade_address,
    claimPublicKey: r.claim_public_key,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class AddressesRepo {
  constructor(private db: Db) {}

  create(p: CreateAddressParams): AddressRow {
    const now = Date.now();
    const enc = p.encryptedToken ?? null;
    const info = this.db
      .prepare(
        `INSERT INTO addresses
           (domain_id, username, session_id, token_ciphertext, token_iv, token_tag,
            claim_code_hash, status, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.domainId,
        p.username.toLowerCase(),
        p.sessionId ?? null,
        enc?.ciphertext ?? null,
        enc?.iv ?? null,
        enc?.tag ?? null,
        p.claimCodeHash ?? null,
        p.status,
        p.metadata ?? null,
        now,
        now,
      );
    return this.getById(Number(info.lastInsertRowid))!;
  }

  getById(id: number): AddressRow | undefined {
    const r = this.db.prepare("SELECT * FROM addresses WHERE id = ?").get(id) as AddressRecord | undefined;
    return r ? rowToAddress(r) : undefined;
  }

  getByDomainAndUsername(domainId: number, username: string): AddressRow | undefined {
    const r = this.db
      .prepare("SELECT * FROM addresses WHERE domain_id = ? AND username = ?")
      .get(domainId, username.toLowerCase()) as AddressRecord | undefined;
    return r ? rowToAddress(r) : undefined;
  }

  listBySessionId(sessionId: string): AddressRow[] {
    const rows = this.db.prepare("SELECT * FROM addresses WHERE session_id = ?").all(sessionId) as unknown as AddressRecord[];
    return rows.map(rowToAddress);
  }

  countActiveBySessionId(sessionId: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS c FROM addresses WHERE session_id = ? AND status = 'active'")
      .get(sessionId) as { c: number };
    return r.c;
  }

  updateStatus(id: number, status: AddressStatus): void {
    this.db.prepare("UPDATE addresses SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), id);
  }

  setOfflineReceive(id: number, arkadeAddress: string, claimPublicKey: string): void {
    this.db
      .prepare("UPDATE addresses SET arkade_address = ?, claim_public_key = ?, updated_at = ? WHERE id = ?")
      .run(arkadeAddress, claimPublicKey, Date.now(), id);
  }

  list(filter: { domainId?: number; status?: AddressStatus; q?: string } = {}): AddressRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.domainId != null) { where.push("domain_id = ?"); params.push(filter.domainId); }
    if (filter.status) { where.push("status = ?"); params.push(filter.status); }
    if (filter.q) {
      const escaped = filter.q.toLowerCase().replace(/[%_\\]/g, "\\$&");
      where.push("username LIKE ? ESCAPE '\\'");
      params.push(`%${escaped}%`);
    }
    const sql = `SELECT * FROM addresses ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC`;
    return (this.db.prepare(sql).all(...params) as unknown as AddressRecord[]).map(rowToAddress);
  }

  delete(id: number): void {
    this.db.prepare("DELETE FROM addresses WHERE id = ?").run(id);
  }

  /** Bind a (reserved) address to a wallet: store token + session, clear claim code, activate. */
  bind(id: number, opts: { sessionId: string; encryptedToken: EncryptedToken }): void {
    this.db
      .prepare(
        `UPDATE addresses SET
           session_id = ?, token_ciphertext = ?, token_iv = ?, token_tag = ?,
           claim_code_hash = NULL, status = 'active', updated_at = ?
         WHERE id = ?`,
      )
      .run(opts.sessionId, opts.encryptedToken.ciphertext, opts.encryptedToken.iv, opts.encryptedToken.tag, Date.now(), id);
  }
}
