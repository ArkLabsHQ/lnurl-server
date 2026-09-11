import type { Db } from "./db/connection.js";
import type { OfflineSwapRecoveryV1 } from "./intent-swap.js";

export interface AcceptedOfflineSwap {
  paymentHash: string;
  pr: string;
  sessionId: string;
  preimage: string;
  amountMsat: number;
  recovery: OfflineSwapRecoveryV1;
}

export interface PendingOfflineSwap {
  paymentHash: string;
  preimage: string;
  recovery: OfflineSwapRecoveryV1;
}

interface PendingRow {
  payment_hash: string;
  preimage: string;
  rfq_id: string;
  solver_name: string;
  solver_pubkey: string;
  relays_json: string;
  recovery_version: number;
  recovery_json: string;
  lockup_address: string;
  expected_amount: number;
}

function isRelayUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "ws:" || protocol === "wss:";
  } catch {
    return false;
  }
}

function recoveryOf(row: PendingRow): OfflineSwapRecoveryV1 {
  const relays = JSON.parse(row.relays_json) as unknown;
  const body = JSON.parse(row.recovery_json) as { script?: unknown };
  if (row.recovery_version !== 1) throw new Error(`unsupported offline swap recovery version ${row.recovery_version}`);
  if (!Array.isArray(relays) || relays.length === 0 || !relays.every(isRelayUrl)) throw new Error("invalid offline swap relays");
  if (!body.script || typeof body.script !== "object" || Array.isArray(body.script)) throw new Error("invalid offline swap script recovery");
  if (!Object.values(body.script).every((value) => typeof value === "string")) throw new Error("invalid offline swap script parameter");
  return {
    version: 1,
    solverName: row.solver_name,
    solverPubkey: row.solver_pubkey,
    relays,
    rfqId: row.rfq_id,
    lockupAddress: row.lockup_address,
    expectedAmount: row.expected_amount,
    script: body.script as Record<string, string>,
  };
}

export class OfflineSwapStore {
  constructor(private db: Db, private ttlMs: number, private now: () => number = Date.now) {}

  createAccepted(record: AcceptedOfflineSwap): void {
    const createdAt = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        "INSERT INTO settlements (payment_hash, pr, session_id, settled, preimage, swap_id, payment_option, amount_msat, created_at) VALUES (?, ?, ?, 0, ?, ?, 'lightning', ?, ?)",
      ).run(record.paymentHash, record.pr, record.sessionId, record.preimage, record.recovery.rfqId, record.amountMsat, createdAt);
      this.db.prepare(
        "INSERT INTO offline_swaps (payment_hash, rfq_id, solver_name, solver_pubkey, relays_json, recovery_version, recovery_json, lockup_address, expected_amount, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        record.paymentHash,
        record.recovery.rfqId,
        record.recovery.solverName,
        record.recovery.solverPubkey,
        JSON.stringify(record.recovery.relays),
        record.recovery.version,
        JSON.stringify({ script: record.recovery.script }),
        record.recovery.lockupAddress,
        record.recovery.expectedAmount,
        createdAt,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listPending(): PendingOfflineSwap[] {
    // Recovery shares the settlement TTL. Swaps that expire while this process
    // is down are intentionally not resumed on restart.
    const rows = this.db.prepare(
      `SELECT s.payment_hash, s.preimage, o.rfq_id, o.solver_name, o.solver_pubkey,
              o.relays_json, o.recovery_version, o.recovery_json, o.lockup_address, o.expected_amount
       FROM settlements s JOIN offline_swaps o ON o.payment_hash = s.payment_hash
       WHERE s.settled = 0 AND s.preimage IS NOT NULL AND s.created_at > ?`,
    ).all(this.now() - this.ttlMs) as unknown as PendingRow[];
    return rows.map((row) => ({ paymentHash: row.payment_hash, preimage: row.preimage, recovery: recoveryOf(row) }));
  }

  markSettled(paymentHash: string, preimage: string): boolean {
    return this.db.prepare(
      "UPDATE settlements SET settled = 1, preimage = ?, settled_at = ? WHERE payment_hash = ? AND settled = 0 AND created_at > ?",
    ).run(preimage, this.now(), paymentHash, this.now() - this.ttlMs).changes > 0;
  }
}
