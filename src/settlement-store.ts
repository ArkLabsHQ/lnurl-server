/** A record of one invoice handed to a payer, tracking LUD-21 settlement state. */
export interface SettlementRecord {
  /** bolt11 payment hash (hex) — the verify URL key. */
  paymentHash: string;
  /** The bolt11 handed to the payer. */
  pr: string;
  /** Session that issued the invoice (only that session may report settlement). */
  sessionId: string;
  settled: boolean;
  /** Revealed only once settled; null otherwise. */
  preimage: string | null;
  createdAt: number;
  settledAt: number | null;
}

export interface SettlementStore {
  /** Record a new invoice. Idempotent: a repeated paymentHash is ignored (never resets settled). */
  create(rec: { paymentHash: string; pr: string; sessionId: string }): void;
  /** Mark an invoice settled with its preimage. Returns false if the hash is unknown. */
  markSettled(paymentHash: string, preimage: string): boolean;
  /** Fetch a record, or undefined if unknown or expired. */
  get(paymentHash: string): SettlementRecord | undefined;
}

/** In-memory store used in library / no-DB mode. Lazy expiry on read plus an
 *  opportunistic sweep so the map can't grow unbounded under create-only traffic. */
export class MemorySettlementStore implements SettlementStore {
  private map = new Map<string, SettlementRecord>();
  private calls = 0;

  constructor(private ttlMs: number, private now: () => number = () => Date.now()) {}

  create(rec: { paymentHash: string; pr: string; sessionId: string }): void {
    if (++this.calls % 1000 === 0) this.sweep();
    if (this.map.has(rec.paymentHash)) return;
    this.map.set(rec.paymentHash, {
      ...rec,
      settled: false,
      preimage: null,
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

  private sweep(): void {
    const t = this.now();
    for (const [k, r] of this.map) if (t - r.createdAt >= this.ttlMs) this.map.delete(k);
  }
}
