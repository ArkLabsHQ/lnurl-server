import type { Db } from "../connection.js";
import { deriveHdReceive, hdReceiveSourceId, validateHdReceive, type HdReceiveAllocation, type HdReceiveConfig } from "../../hd-receive.js";

interface AllocationRecord {
  id: number;
  child_index: number;
  descriptor: string;
  arkade_address: string;
  claim_public_key: string;
  hd_receive: string;
  created_at: number;
}

function mapAllocation(row: AllocationRecord): HdReceiveAllocation {
  return { id: row.id, index: row.child_index, descriptor: row.descriptor, arkadeAddress: row.arkade_address, claimPublicKey: row.claim_public_key, hd: validateHdReceive(JSON.parse(row.hd_receive)), createdAt: row.created_at };
}

export class HdReceiveRepo {
  constructor(private db: Db) {}

  allocate(addressId: number, config: HdReceiveConfig): HdReceiveAllocation {
    const hd = validateHdReceive(config);
    const json = JSON.stringify(hd);
    const sourceId = hdReceiveSourceId(hd);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare("SELECT hd_receive, status FROM addresses WHERE id = ?").get(addressId) as { hd_receive: string | null; status: string } | undefined;
      if (!current?.hd_receive || current.status !== "active" || JSON.stringify(validateHdReceive(JSON.parse(current.hd_receive))) !== json) throw new Error("HD receive registration changed or was revoked");
      this.db.prepare("INSERT INTO hd_receive_sources (source_id, next_index) VALUES (?, 0) ON CONFLICT(source_id) DO NOTHING").run(sourceId);
      const { next_index: index } = this.db.prepare("SELECT next_index FROM hd_receive_sources WHERE source_id = ?").get(sourceId) as { next_index: number };
      const { maximum } = this.db.prepare("SELECT MAX(child_index) AS maximum FROM hd_receive_allocations WHERE source_id = ?").get(sourceId) as { maximum: number | null };
      if (maximum !== null && index <= maximum) throw new Error("HD receive counter is inconsistent with allocation history");
      const derived = deriveHdReceive(hd, index);
      const createdAt = Date.now();
      const result = this.db.prepare("INSERT INTO hd_receive_allocations (address_id, source_id, child_index, descriptor, arkade_address, claim_public_key, hd_receive, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(addressId, sourceId, index, derived.descriptor, derived.arkadeAddress, derived.claimPublicKey, json, createdAt);
      this.db.prepare("UPDATE hd_receive_sources SET next_index = ? WHERE source_id = ?").run(index + 1, sourceId);
      this.db.exec("COMMIT");
      return { id: Number(result.lastInsertRowid), index, ...derived, hd, createdAt };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  list(addressId: number, after: number, limit: number): HdReceiveAllocation[] {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("invalid HD receive allocation page");
    const rows = this.db.prepare("SELECT * FROM hd_receive_allocations WHERE address_id = ? AND id > ? ORDER BY id LIMIT ?").all(addressId, after, limit) as unknown as AllocationRecord[];
    return rows.map(mapAllocation);
  }
}
