/** Fixed-window per-key limiter. Injectable clock for testing. */
export class RateLimiter {
  private hits = new Map<string, { count: number; windowStart: number }>();

  constructor(private limit: number, private windowMs: number, private now: () => number = () => Date.now()) {}

  allow(key: string): boolean {
    const t = this.now();
    const entry = this.hits.get(key);
    if (!entry || t - entry.windowStart >= this.windowMs) {
      this.hits.set(key, { count: 1, windowStart: t });
      return true;
    }
    if (entry.count >= this.limit) return false;
    entry.count += 1;
    return true;
  }
}
