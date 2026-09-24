import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCatchUpLoop } from "../src/workers/catch-up-loop.js";

describe("startCatchUpLoop", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports a rejected pass and keeps running", async () => {
    const errors: unknown[] = [];
    let passes = 0;
    const loop = startCatchUpLoop({
      pass: async () => { passes++; throw new Error("indexer down"); },
      intervalMs: 1_000,
      onError: (err) => errors.push(err),
      immediate: true,
    });
    await vi.advanceTimersByTimeAsync(2_500);
    loop.stop();
    expect(passes).toBe(3);
    expect(errors).toHaveLength(3);
  });

  it("reports a pass that throws before returning a promise", async () => {
    const errors: unknown[] = [];
    const loop = startCatchUpLoop({
      pass: () => { throw new Error("sqlite busy"); },
      intervalMs: 1_000,
      onError: (err) => errors.push(err),
      immediate: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    loop.stop();
    expect(errors).toHaveLength(1);
  });

  it("waits one interval before the first pass unless immediate", async () => {
    let passes = 0;
    const loop = startCatchUpLoop({ pass: async () => { passes++; }, intervalMs: 1_000, onError: () => {} });
    await vi.advanceTimersByTimeAsync(999);
    expect(passes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    loop.stop();
    expect(passes).toBe(1);
  });

  it("queues one pass behind a running one, however many triggers arrive", async () => {
    let passes = 0;
    let release!: () => void;
    const loop = startCatchUpLoop({
      pass: () => { passes++; return passes === 1 ? new Promise<void>((r) => { release = r; }) : Promise.resolve(); },
      intervalMs: 60_000,
      onError: () => {},
      immediate: true,
    });
    loop.trigger();
    loop.trigger();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await vi.advanceTimersByTimeAsync(0);
    loop.stop();
    expect(passes).toBe(2);
  });

  it("runs nothing after stop", async () => {
    let passes = 0;
    const loop = startCatchUpLoop({ pass: async () => { passes++; }, intervalMs: 1_000, onError: () => {}, immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    loop.stop();
    loop.trigger();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(passes).toBe(1);
  });
});
