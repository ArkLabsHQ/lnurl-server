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
});
