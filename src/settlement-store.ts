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
  /** RFQ id of a server-created offline-receive swap; null for relay invoices. */
  swapId: string | null;
  /** LUD-XX payment rail. "lightning" (BOLT11) is the default; e.g. "arkade" for a direct destination. */
  paymentOption: string;
  /** Non-`pr` destination (e.g. an Arkade address) for a destination-based option; null for lightning. */
  paymentDestination: string | null;
  /** Method-specific settlement reference (e.g. a txid) once the service observes it; null until then. */
  paymentReference: string | null;
  /** The agreed amount. Recorded so a future Arkade watcher can correlate the observed
   *  payment against it — without it an under-payment would flip settled just the same. */
  amountMsat: number | null;
  createdAt: number;
  settledAt: number | null;
}

/** A pending offline-receive swap awaiting solver settlement, for the poller. */
export interface PendingSwap {
  swapId: string;
  paymentHash: string;
  preimage: string;
}

/** A pending destination-rail record awaiting an observed Arkade payment, for the watcher. */
export interface PendingDestination {
  /** The opaque verify id (destination records are not keyed by a real payment hash). */
  paymentHash: string;
  paymentDestination: string;
  amountMsat: number;
  createdAt: number;
}

export interface SettlementStore {
  /** Record a new invoice. Idempotent: a repeated paymentHash is ignored (never resets settled).
   *  Offline swaps pass `preimage` + `swapId` up front (held privately until settled). */
  create(rec: { paymentHash: string; pr: string; sessionId: string; preimage?: string; swapId?: string; paymentOption?: string; paymentDestination?: string; amountMsat?: number }): void;
  /** Mark an invoice settled with its preimage. Returns false if the hash is unknown. */
  markSettled(paymentHash: string, preimage: string): boolean;
  /** Mark a destination record settled from an observed payment — reference is the
   *  method-specific proof (the Arkade txid), never a preimage. */
  markObserved(paymentHash: string, reference: string): boolean;
  /** Fetch a record, or undefined if unknown or expired. */
  get(paymentHash: string): SettlementRecord | undefined;
  /** Unsettled offline swaps (have a swapId) for the settlement poller. */
  listPendingSwaps(): PendingSwap[];
  /** Unsettled destination-rail records (non-lightning) with an amount, for the watcher. */
  listPendingDestinations(): PendingDestination[];
  /** True when a reference (e.g. an Arkade txid) already settled some record —
   *  one observed payment must not settle two records across watcher passes. */
  isReferenceUsed(reference: string): boolean;
}

/** In-memory store used in library / no-DB mode. Lazy expiry on read plus an
 *  opportunistic sweep so the map can't grow unbounded under create-only traffic. */
export class MemorySettlementStore implements SettlementStore {
  private map = new Map<string, SettlementRecord>();
  private calls = 0;

  constructor(private ttlMs: number, private now: () => number = () => Date.now()) {}

  create(rec: { paymentHash: string; pr: string; sessionId: string; preimage?: string; swapId?: string; paymentOption?: string; paymentDestination?: string; amountMsat?: number }): void {
    if (++this.calls % 1000 === 0) this.sweep();
    if (this.map.has(rec.paymentHash)) return;
    this.map.set(rec.paymentHash, {
      paymentHash: rec.paymentHash,
      pr: rec.pr,
      sessionId: rec.sessionId,
      settled: false,
      preimage: rec.preimage ?? null,
      swapId: rec.swapId ?? null,
      paymentOption: rec.paymentOption ?? "lightning",
      paymentDestination: rec.paymentDestination ?? null,
      paymentReference: null,
      amountMsat: rec.amountMsat ?? null,
      createdAt: this.now(),
      settledAt: null,
    });
  }

  markSettled(paymentHash: string, preimage: string): boolean {
    const r = this.get(paymentHash);
    if (!r || r.settled) return false; // idempotent: a settled record never re-flips
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
    const t = this.now();
    for (const r of this.map.values()) {
      // Past-TTL records stop being polled — their invoices expired long ago.
      if (t - r.createdAt >= this.ttlMs) continue;
      if (r.swapId && !r.settled && r.preimage) {
        out.push({ swapId: r.swapId, paymentHash: r.paymentHash, preimage: r.preimage });
      }
    }
    return out;
  }

  listPendingDestinations(): PendingDestination[] {
    const out: PendingDestination[] = [];
    const t = this.now();
    for (const r of this.map.values()) {
      if (t - r.createdAt >= this.ttlMs) continue;
      // amountMsat missing → an observed payment can never be amount-checked, so
      // skip rather than flip on any payment. Option missing == lightning.
      if (r.paymentOption != null && r.paymentOption !== "lightning" && !r.settled && r.paymentDestination && r.amountMsat != null) {
        out.push({ paymentHash: r.paymentHash, paymentDestination: r.paymentDestination, amountMsat: r.amountMsat, createdAt: r.createdAt });
      }
    }
    return out;
  }

  markObserved(paymentHash: string, reference: string): boolean {
    const r = this.get(paymentHash);
    if (!r || r.settled) return false; // idempotent: never overwrite a settlement's reference
    r.settled = true;
    r.paymentReference = reference;
    r.settledAt = this.now();
    return true;
  }

  isReferenceUsed(reference: string): boolean {
    for (const r of this.map.values()) if (r.paymentReference === reference) return true;
    return false;
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
  payment_option: string | null;
  payment_destination: string | null;
  payment_reference: string | null;
  amount_msat: number | null;
  created_at: number;
  settled_at: number | null;
}

/** SQLite-backed store (migration 003). Survives restart and outlives the SSE
 *  session — a payer may poll `verify` after the wallet disconnects. Expiry is
 *  lazy on read. */
export class DbSettlementStore implements SettlementStore {
  constructor(private db: Db, private ttlMs: number, private now: () => number = () => Date.now()) {}

  create(rec: { paymentHash: string; pr: string; sessionId: string; preimage?: string; swapId?: string; paymentOption?: string; paymentDestination?: string; amountMsat?: number }): void {
    const info = this.db
      .prepare(
        "INSERT OR IGNORE INTO settlements (payment_hash, pr, session_id, settled, preimage, swap_id, payment_option, payment_destination, amount_msat, created_at, settled_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, NULL)",
      )
      .run(
        rec.paymentHash,
        rec.pr,
        rec.sessionId,
        rec.preimage ?? null,
        rec.swapId ?? null,
        rec.paymentOption ?? "lightning",
        rec.paymentDestination ?? null,
        rec.amountMsat ?? null,
        this.now(),
      );
    // A paymentHash collision on the offline path would leave `verify` polling the
    // OLD record while the payer got the NEW invoice — cryptographically negligible,
    // but loud if it ever happens.
    if (info.changes === 0 && rec.swapId) {
      console.warn(`settlements: insert ignored for existing paymentHash ${rec.paymentHash} (offline swap ${rec.swapId})`);
    }
  }

  markSettled(paymentHash: string, preimage: string): boolean {
    // `created_at >` keeps this in step with `get`, which treats an expired
    // record as absent — settling one nothing can read afterwards is a lie.
    const info = this.db
      .prepare(
        "UPDATE settlements SET settled = 1, preimage = ?, settled_at = ? WHERE payment_hash = ? AND settled = 0 AND created_at > ?",
      )
      .run(preimage, this.now(), paymentHash, this.now() - this.ttlMs);
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
      paymentOption: row.payment_option ?? "lightning",
      paymentDestination: row.payment_destination ?? null,
      paymentReference: row.payment_reference ?? null,
      amountMsat: row.amount_msat ?? null,
      createdAt: row.created_at,
      settledAt: row.settled_at ?? null,
    };
  }

  listPendingSwaps(): PendingSwap[] {
    const rows = this.db
      .prepare(
        // Past-TTL records stop being polled — their invoices expired long ago.
        "SELECT payment_hash, preimage, swap_id FROM settlements WHERE swap_id IS NOT NULL AND settled = 0 AND preimage IS NOT NULL AND created_at > ?",
      )
      .all(this.now() - this.ttlMs) as unknown as { payment_hash: string; preimage: string; swap_id: string }[];
    return rows.map((r) => ({ swapId: r.swap_id, paymentHash: r.payment_hash, preimage: r.preimage }));
  }

  listPendingDestinations(): PendingDestination[] {
    const rows = this.db
      .prepare(
        "SELECT payment_hash, payment_destination, amount_msat, created_at FROM settlements WHERE settled = 0 AND payment_option IS NOT NULL AND payment_option != 'lightning' AND payment_destination IS NOT NULL AND amount_msat IS NOT NULL AND created_at > ?",
      )
      .all(this.now() - this.ttlMs) as unknown as { payment_hash: string; payment_destination: string; amount_msat: number; created_at: number }[];
    return rows.map((r) => ({ paymentHash: r.payment_hash, paymentDestination: r.payment_destination, amountMsat: r.amount_msat, createdAt: r.created_at }));
  }

  markObserved(paymentHash: string, reference: string): boolean {
    // Idempotent: a second observation must not overwrite the first's reference.
    const info = this.db
      .prepare(
        "UPDATE settlements SET settled = 1, payment_reference = ?, settled_at = ? WHERE payment_hash = ? AND settled = 0 AND created_at > ?",
      )
      .run(reference, this.now(), paymentHash, this.now() - this.ttlMs);
    return info.changes > 0;
  }

  isReferenceUsed(reference: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM settlements WHERE payment_reference = ? LIMIT 1").get(reference));
  }
}
