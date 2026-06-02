import { describe, it, expect } from "vitest";
import { RateLimiter } from "../src/rate-limit.js";

describe("RateLimiter", () => {
  it("allows up to the limit per window, then blocks", () => {
    let now = 1000;
    const rl = new RateLimiter(2, 60_000, () => now);
    expect(rl.allow("ip1")).toBe(true);
    expect(rl.allow("ip1")).toBe(true);
    expect(rl.allow("ip1")).toBe(false);
    expect(rl.allow("ip2")).toBe(true); // independent key
    now += 60_001;
    expect(rl.allow("ip1")).toBe(true); // window reset
  });

  it("sweeps expired entries so the map stays bounded", () => {
    let now = 1000;
    const rl = new RateLimiter(5, 1000, () => now, /* sweepEvery */ 2);
    rl.allow("a");           // call 1
    rl.allow("b");           // call 2 → sweep (a,b still fresh)
    expect(rl.size()).toBe(2);
    now += 2000;             // advance past the window
    rl.allow("c");           // call 3
    rl.allow("d");           // call 4 → sweep evicts the expired a,b
    expect(rl.size()).toBe(2); // only c,d remain
  });
});
