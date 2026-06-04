/** Fixed-window per-key limiter. Injectable clock for testing.
 *  Expired entries are swept periodically (every `sweepEvery` calls) so the
 *  internal map can't grow unbounded under traffic from many distinct keys/IPs. */
export class RateLimiter {
  private hits = new Map<string, { count: number; windowStart: number }>();
  private calls = 0;

  constructor(
    // Number, or a getter so the limit can be changed at runtime (e.g. from editable settings).
    private limit: number | (() => number),
    private windowMs: number,
    private now: () => number = () => Date.now(),
    private sweepEvery: number = 1000,
  ) {}

  allow(key: string): boolean {
    const t = this.now();
    if (++this.calls % this.sweepEvery === 0) this.sweep(t);
    const limit = typeof this.limit === "function" ? this.limit() : this.limit;
    const entry = this.hits.get(key);
    if (!entry || t - entry.windowStart >= this.windowMs) {
      this.hits.set(key, { count: 1, windowStart: t });
      return true;
    }
    if (entry.count >= limit) return false;
    entry.count += 1;
    return true;
  }

  /** Number of tracked keys (for testing / observability). */
  size(): number {
    return this.hits.size;
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.hits) {
      if (now - entry.windowStart >= this.windowMs) this.hits.delete(key);
    }
  }
}
