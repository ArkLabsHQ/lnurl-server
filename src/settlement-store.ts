import type { Db } from "./db/connection.js";

/** A record of one invoice handed to a payer, tracking LUD-21 settlement state. */
export interface SettlementRecord {
  /** bolt11 payment hash (hex) — the verify URL key. */
  paymentHash: string;
  /** The bolt11 handed to the payer. */
  pr: string;
  /** Session that issued the invoice (only that session may report settlement). */
  sessionId: string;
  settled: boolean;
  /** For relay invoices, revealed only once settled. For offline swaps the server
   *  holds it from creation, but the verify route still gates exposure on `settled`. */
  preimage: string | null;
  /** Boltz swap id for a server-created offline-receive swap; null for relay invoices. */
  swapId: string | null;
  createdAt: number;
  settledAt: number | null;
}

/** A pending offline-receive swap awaiting Boltz settlement, for the poller. */
export interface PendingSwap {
  swapId: string;
  paymentHash: string;
  preimage: string;
}

export interface SettlementStore {
  /** Record a new invoice. Idempotent: a repeated paymentHash is ignored (never resets settled).
   *  Offline swaps pass `preimage` + `swapId` up front (held privately until settled). */
  create(rec: { paymentHash: string; pr: string; sessionId: string; preimage?: string; swapId?: string }): void;
  /** Mark an invoice settled with its preimage. Returns false if the hash is unknown. */
  markSettled(paymentHash: string, preimage: string): boolean;
  /** Fetch a record, or undefined if unknown or expired. */
  get(paymentHash: string): SettlementRecord | undefined;
  /** Unsettled offline swaps (have a swapId) for the settlement poller. */
  listPendingSwaps(): PendingSwap[];
}

/** In-memory store used in library / no-DB mode. Lazy expiry on read plus an
 *  opportunistic sweep so the map can't grow unbounded under create-only traffic. */
export class MemorySettlementStore implements SettlementStore {
  private map = new Map<string, SettlementRecord>();
  private calls = 0;

  constructor(private ttlMs: number, private now: () => number = () => Date.now()) {}

  create(rec: { paymentHash: string; pr: string; sessionId: string; preimage?: string; swapId?: string }): void {
    if (++this.calls % 1000 === 0) this.sweep();
    if (this.map.has(rec.paymentHash)) return;
    this.map.set(rec.paymentHash, {
      paymentHash: rec.paymentHash,
      pr: rec.pr,
      sessionId: rec.sessionId,
      settled: false,
      preimage: rec.preimage ?? null,
      swapId: rec.swapId ?? null,
      createdAt: this.now(),
      settledAt: null,
    });
  }

  markSettled(paymentHash: string, preimage: string): boolean {
    const r = this.get(paymentHash);
    if (!r) return false;
    r.settled = true;
    r.preimage = preimage;
    r.settledAt = this.now();
    return true;
  }

  get(paymentHash: string): SettlementRecord | undefined {
    const r = this.map.get(paymentHash);
    if (!r) return undefined;
    if (this.now() - r.createdAt >= this.ttlMs) {
      this.map.delete(paymentHash);
      return undefined;
    }
    return r;
  }

  listPendingSwaps(): PendingSwap[] {
    const out: PendingSwap[] = [];
    for (const r of this.map.values()) {
      if (r.swapId && !r.settled && r.preimage) {
        out.push({ swapId: r.swapId, paymentHash: r.paymentHash, preimage: r.preimage });
      }
    }
    return out;
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, r] of this.map) if (t - r.createdAt >= this.ttlMs) this.map.delete(k);
  }
}

interface SettlementRow {
  payment_hash: string;
  pr: string;
  session_id: string;
  settled: number;
  preimage: string | null;
  swap_id: string | null;
  created_at: number;
  settled_at: number | null;
}

/** SQLite-backed store (migration 003). Survives restart and outlives the SSE
 *  session — a payer may poll `verify` after the wallet disconnects. Expiry is
 *  lazy on read. */
export class DbSettlementStore implements SettlementStore {
  constructor(private db: Db, private ttlMs: number, private now: () => number = () => Date.now()) {}

  create(rec: { paymentHash: string; pr: string; sessionId: string; preimage?: string; swapId?: string }): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO settlements (payment_hash, pr, session_id, settled, preimage, swap_id, created_at, settled_at) VALUES (?, ?, ?, 0, ?, ?, ?, NULL)",
      )
      .run(rec.paymentHash, rec.pr, rec.sessionId, rec.preimage ?? null, rec.swapId ?? null, this.now());
  }

  markSettled(paymentHash: string, preimage: string): boolean {
    const info = this.db
      .prepare("UPDATE settlements SET settled = 1, preimage = ?, settled_at = ? WHERE payment_hash = ?")
      .run(preimage, this.now(), paymentHash);
    return info.changes > 0;
  }

  get(paymentHash: string): SettlementRecord | undefined {
    const row = this.db.prepare("SELECT * FROM settlements WHERE payment_hash = ?").get(paymentHash) as unknown as
      | SettlementRow
      | undefined;
    if (!row) return undefined;
    if (this.now() - row.created_at >= this.ttlMs) {
      this.db.prepare("DELETE FROM settlements WHERE payment_hash = ?").run(paymentHash);
      return undefined;
    }
    return {
      paymentHash: row.payment_hash,
      pr: row.pr,
      sessionId: row.session_id,
      settled: !!row.settled,
      preimage: row.preimage ?? null,
      swapId: row.swap_id ?? null,
      createdAt: row.created_at,
      settledAt: row.settled_at ?? null,
    };
  }

  listPendingSwaps(): PendingSwap[] {
    const rows = this.db
      .prepare(
        "SELECT payment_hash, preimage, swap_id FROM settlements WHERE swap_id IS NOT NULL AND settled = 0 AND preimage IS NOT NULL",
      )
      .all() as unknown as { payment_hash: string; preimage: string; swap_id: string }[];
    return rows.map((r) => ({ swapId: r.swap_id, paymentHash: r.payment_hash, preimage: r.preimage }));
  }
}
