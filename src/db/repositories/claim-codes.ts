import type { Db } from "../connection.js";

export interface ClaimCodeRow {
  id: number;
  domainId: number;
  addressId: number | null;
  createdAt: number;
  redeemedAt: number | null;
}

interface ClaimCodeRecord {
  id: number;
  domain_id: number;
  address_id: number | null;
  created_at: number;
  redeemed_at: number | null;
}

const toRow = (r: ClaimCodeRecord): ClaimCodeRow => ({
  id: r.id, domainId: r.domain_id, addressId: r.address_id, createdAt: r.created_at, redeemedAt: r.redeemed_at,
});

/** Single-use codes for any free name on a domain. Only the code's hash is stored. */
export class ClaimCodesRepo {
  constructor(private db: Db) {}

  create(domainId: number, codeHash: Buffer): ClaimCodeRow {
    const info = this.db
      .prepare("INSERT INTO claim_codes (domain_id, code_hash, created_at) VALUES (?, ?, ?)")
      .run(domainId, codeHash, Date.now());
    return toRow(this.db.prepare("SELECT * FROM claim_codes WHERE id = ?").get(Number(info.lastInsertRowid)) as unknown as ClaimCodeRecord);
  }

  getUnspent(domainId: number, codeHash: Buffer): ClaimCodeRow | undefined {
    const r = this.db
      .prepare("SELECT * FROM claim_codes WHERE domain_id = ? AND code_hash = ? AND redeemed_at IS NULL")
      .get(domainId, codeHash) as ClaimCodeRecord | undefined;
    return r ? toRow(r) : undefined;
  }

  /** False when the code was already spent. */
  redeem(id: number, addressId: number): boolean {
    return this.db
      .prepare("UPDATE claim_codes SET redeemed_at = ?, address_id = ? WHERE id = ? AND redeemed_at IS NULL")
      .run(Date.now(), addressId, id).changes === 1;
  }

  list(domainId?: number): (ClaimCodeRow & { username: string | null })[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, a.username AS username FROM claim_codes c LEFT JOIN addresses a ON a.id = c.address_id
         WHERE ? IS NULL OR c.domain_id = ? ORDER BY c.id DESC`,
      )
      .all(domainId ?? null, domainId ?? null) as unknown as (ClaimCodeRecord & { username: string | null })[];
    return rows.map((r) => ({ ...toRow(r), username: r.username }));
  }

  delete(id: number): boolean {
    return this.db.prepare("DELETE FROM claim_codes WHERE id = ?").run(id).changes === 1;
  }
}
