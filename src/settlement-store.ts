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
  /** Set on destination records with a per-payment covenant address; null for the
   *  static-address shape and for lightning. @see covenant-destination.ts */
  covenantScript: string | null;
  /** Supply index the covenant preimage came from; null when it was random and
   *  the owner therefore cannot re-derive it. @see covenant-supply.ts */
  covenantIndex: number | null;
  /** Slot taken from the SWAP supply. A different secret from the same index
   *  in the covenant supply, which is why it is its own column. */
  swapIndex: number | null;
  addressId: number | null;
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
  /** hex pkScript of this record's own destination. Present makes attribution exact:
   *  a VTXO there belongs to this record and to no other. */
  covenantScript: string | null;
}

/** What `create` accepts. Covenant fields arrive together or not at all. */
export interface NewSettlement {
  paymentHash: string;
  pr: string;
  sessionId: string;
  preimage?: string;
  swapId?: string;
  paymentOption?: string;
  paymentDestination?: string;
  amountMsat?: number;
  covenantScript?: string;
  covenantIndex?: number;
  swapIndex?: number;
  addressId?: number;
}

export interface SettlementStore {
  /** Record a new invoice. Idempotent: a repeated paymentHash is ignored (never resets settled).
   *  Offline swaps pass `preimage` + `swapId` up front (held privately until settled). */
  create(rec: NewSettlement): void;
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
  /** Newest-first audit view for the admin API (no TTL filter — history, not polling).
   *  Filters are pushed into the query so a filtered page isn't silently truncated. */
  listRecent(limit: number, opts?: { settled?: boolean; option?: string }): SettlementRecord[];
  listByAddress(addressId: number, limit: number, opts?: { since?: number }): SettlementRecord[];
}

/** In-memory store used in library / no-DB mode. Lazy expiry on read plus an
 *  opportunistic sweep so the map can't grow unbounded under create-only traffic. */
export class MemorySettlementStore implements SettlementStore {
  private map = new Map<string, SettlementRecord>();
  private calls = 0;

  constructor(
    private ttlMs: number,
    private now: () => number = () => Date.now(),
    private destinationWatchMs: number = ttlMs,
  ) {}

  create(rec: NewSettlement): void {
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
      covenantScript: rec.covenantScript ?? null,
      covenantIndex: rec.covenantIndex ?? null,
      swapIndex: rec.swapIndex ?? null,
      addressId: rec.addressId ?? null,
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
    const lifetime = r.paymentOption && r.paymentOption !== "lightning" ? this.destinationWatchMs : this.ttlMs;
    if (this.now() - r.createdAt >= lifetime) {
      // Same rules as the DB store: a destination outlives the verify TTL, and
      // an address's history outlives both.
      if (r.addressId === null || r.addressId === undefined) this.map.delete(paymentHash);
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
      // destinationWatchMs, not ttlMs: a hold invoice really does expire, so
      // dropping it is safe. A destination stays payable forever and the
      // callback advertises no expiry, so giving up on it means a payment that
      // does arrive is never observed, never swept, and never reaches its
      // owner's history.
      if (t - r.createdAt >= this.destinationWatchMs) continue;
      // amountMsat missing → an observed payment can never be amount-checked, so
      // skip rather than flip on any payment. Option missing == lightning.
      if (r.paymentOption != null && r.paymentOption !== "lightning" && !r.settled && r.paymentDestination && r.amountMsat != null) {
        out.push({
          paymentHash: r.paymentHash,
          paymentDestination: r.paymentDestination,
          amountMsat: r.amountMsat,
          createdAt: r.createdAt,
          covenantScript: r.covenantScript,
        });
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

  listByAddress(addressId: number, limit: number, opts?: { since?: number }): SettlementRecord[] {
    return [...this.map.values()]
      .filter((r) => r.addressId === addressId && (opts?.since === undefined || r.createdAt >= opts.since))
      .sort((a, b) => a.createdAt - b.createdAt || (a.paymentHash < b.paymentHash ? -1 : 1))
      .slice(0, limit);
  }

  listRecent(limit: number, opts?: { settled?: boolean; option?: string }): SettlementRecord[] {
    return [...this.map.values()]
      .filter((r) => (opts?.settled === undefined || r.settled === opts.settled) && (opts?.option === undefined || r.paymentOption === opts.option))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, r] of this.map) {
      if (t - r.createdAt >= this.ttlMs && (r.addressId === null || r.addressId === undefined)) this.map.delete(k);
    }
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
  covenant_script: string | null;
  covenant_index: number | null;
  swap_index: number | null;
  address_id: number | null;
  created_at: number;
  settled_at: number | null;
}

/** SQLite-backed store (migration 003). Survives restart and outlives the SSE
 *  session — a payer may poll `verify` after the wallet disconnects. Expiry is
 *  lazy on read. */
export class DbSettlementStore implements SettlementStore {
  constructor(
    private db: Db,
    private ttlMs: number,
    private now: () => number = () => Date.now(),
    private destinationWatchMs: number = ttlMs,
  ) {}

  create(rec: NewSettlement): void {
    const info = this.db
      .prepare(
        "INSERT OR IGNORE INTO settlements (payment_hash, pr, session_id, settled, preimage, swap_id, payment_option, payment_destination, amount_msat, covenant_script, covenant_index, swap_index, address_id, created_at, settled_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
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
        rec.covenantScript ?? null,
        rec.covenantIndex ?? null,
        rec.swapIndex ?? null,
        rec.addressId ?? null,
        this.now(),
      );
    // A paymentHash collision on the offline path would leave `verify` polling the
    // OLD record while the payer got the NEW invoice — cryptographically negligible,
    // but loud if it ever happens.
    if (info.changes === 0 && rec.swapId) {
      console.warn(`settlements: insert ignored for existing paymentHash ${rec.paymentHash} (offline swap ${rec.swapId})`);
    }
    // OR IGNORE swallows the unique index, and an ignored insert would hand a payer
    // an address whose record does not exist.
    if (info.changes === 0 && rec.covenantScript) {
      throw new Error(`settlements: covenant script ${rec.covenantScript} is already in use`);
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
    // A record stays readable for as long as the server will still honour it.
    // A bolt11 invoice is dead at the verify TTL; a destination is live until
    // the watch window closes, and telling a payer "unknown" about a payment
    // the watcher would still settle is the wrong answer.
    const lifetime =
      row.payment_option && row.payment_option !== "lightning" ? this.destinationWatchMs : this.ttlMs;
    if (this.now() - row.created_at >= lifetime) {
      // Expiry hides a record from verify, but only an unattributed one is
      // reclaimed. A row carrying an address_id is that owner's history and the
      // only copy of it — and a wallet offline past the TTL is precisely the
      // case the sync source exists for, so deleting here let any payer's
      // verify poll erase a receive its owner had not seen yet.
      if (row.address_id === null || row.address_id === undefined) {
        this.db.prepare("DELETE FROM settlements WHERE payment_hash = ?").run(paymentHash);
      }
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
      covenantScript: row.covenant_script ?? null,
      covenantIndex: row.covenant_index ?? null,
      swapIndex: row.swap_index ?? null,
      addressId: row.address_id ?? null,
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
        "SELECT payment_hash, payment_destination, amount_msat, created_at, covenant_script FROM settlements WHERE settled = 0 AND payment_option IS NOT NULL AND payment_option != 'lightning' AND payment_destination IS NOT NULL AND amount_msat IS NOT NULL AND created_at > ?",
      )
      // See the memory store: a destination outlives the verify TTL because it
      // stays payable and nothing tells the payer otherwise.
      .all(this.now() - this.destinationWatchMs) as unknown as {
      payment_hash: string;
      payment_destination: string;
      amount_msat: number;
      created_at: number;
      covenant_script: string | null;
    }[];
    return rows.map((r) => ({
      paymentHash: r.payment_hash,
      paymentDestination: r.payment_destination,
      amountMsat: r.amount_msat,
      createdAt: r.created_at,
      covenantScript: r.covenant_script,
    }));
  }

  markObserved(paymentHash: string, reference: string): boolean {
    // Idempotent: a second observation must not overwrite the first's reference.
    const info = this.db
      .prepare(
        "UPDATE settlements SET settled = 1, payment_reference = ?, settled_at = ? WHERE payment_hash = ? AND settled = 0 AND created_at > ?",
      )
      // Both callers are destination watchers, so this tracks the watch window
      // rather than the verify TTL. Gating it on the shorter one meant the
      // watcher could find a late payment and then fail to record it, which
      // reads as "no payment" from every angle a caller can see.
      .run(reference, this.now(), paymentHash, this.now() - this.destinationWatchMs);
    return info.changes > 0;
  }

  isReferenceUsed(reference: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM settlements WHERE payment_reference = ? LIMIT 1").get(reference));
  }

  listRecent(limit: number, opts?: { settled?: boolean; option?: string }): SettlementRecord[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts?.settled !== undefined) {
      where.push("settled = ?");
      params.push(opts.settled ? 1 : 0);
    }
    if (opts?.option !== undefined) {
      where.push("payment_option = ?");
      params.push(opts.option);
    }
    const rows = this.db
      .prepare(`SELECT * FROM settlements${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit) as unknown as SettlementRow[];
    return rows.map((row) => ({
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
      covenantScript: row.covenant_script ?? null,
      covenantIndex: row.covenant_index ?? null,
      swapIndex: row.swap_index ?? null,
      addressId: row.address_id ?? null,
      createdAt: row.created_at,
      settledAt: row.settled_at ?? null,
    }));
  }

  listByAddress(addressId: number, limit: number, opts?: { since?: number }): SettlementRecord[] {
    const where: string[] = ["address_id = ?"];
    const params: (string | number)[] = [addressId];
    if (opts?.since !== undefined) {
      where.push("created_at >= ?");
      params.push(opts.since);
    }
    const rows = this.db
      .prepare(`SELECT * FROM settlements WHERE ${where.join(" AND ")} ORDER BY created_at ASC, payment_hash ASC LIMIT ?`)
      .all(...params, limit) as unknown as SettlementRow[];
    return rows.map((row) => ({
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
      covenantScript: row.covenant_script ?? null,
      covenantIndex: row.covenant_index ?? null,
      swapIndex: row.swap_index ?? null,
      addressId: row.address_id ?? null,
      createdAt: row.created_at,
      settledAt: row.settled_at ?? null,
    }));
  }
}
