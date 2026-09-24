import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { VerifyBatchStreamHandlers } from "@arkade-os/lnurl-client";
import { watchSettlement } from "../src/batch-verify.js";

function fakeOpener() {
  const opened: VerifyBatchStreamHandlers[] = [];
  const closes: number[] = [];
  const open = vi.fn((_opts: unknown, handlers: VerifyBatchStreamHandlers) => {
    const i = opened.push(handlers) - 1;
    return { sessionId: undefined, update: () => undefined, close: () => { closes.push(i); handlers.onClose?.(); } };
  });
  return { open, opened, closes };
}

const OPTS = { verifyBatchUrl: "https://x/lnurl/verifyBatch", verifyUrl: "https://x/lnurl/verify/ab" };
const settledStatus = { kind: "bolt11", settled: true, preimage: "00", pr: "lnbc1" } as const;

describe("watchSettlement", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("reopens after the server closes the stream, and stops on settlement", async () => {
    const { open, opened } = fakeOpener();
    const settled = vi.fn();
    watchSettlement({ ...OPTS, open }, { settled, gaveUp: vi.fn() });
    opened[0]!.onClose?.();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(open).toHaveBeenCalledTimes(2);
    opened[1]!.onUpdate?.(OPTS.verifyUrl, settledStatus);
    expect(settled).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("does not reopen once stopped, and closes the live stream", async () => {
    const { open, closes } = fakeOpener();
    const watch = watchSettlement({ ...OPTS, open }, { settled: vi.fn(), gaveUp: vi.fn() });
    watch.stop();
    expect(closes).toEqual([0]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("gives up at the deadline with the last stream error", async () => {
    const { open, opened } = fakeOpener();
    const gaveUp = vi.fn();
    watchSettlement({ ...OPTS, open, timeoutMs: 5_000 }, { settled: vi.fn(), gaveUp });
    for (let i = 0; i < 10 && gaveUp.mock.calls.length === 0; i++) {
      const h = opened[opened.length - 1]!;
      h.onError?.(new Error("Bad Request"));
      h.onClose?.();
      await vi.advanceTimersByTimeAsync(4_000);
    }
    expect(gaveUp).toHaveBeenCalledWith("Bad Request");
  });
});
