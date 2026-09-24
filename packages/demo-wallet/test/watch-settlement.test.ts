import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { VerifyBatchStreamHandlers } from "@arkade-os/lnurl-client";
import { settlementWatcher } from "../src/batch-verify.js";

function fakeOpener(opts: { sessionless?: boolean } = {}) {
  const opened: VerifyBatchStreamHandlers[] = [];
  const sets: string[][] = [];
  const updates: [string[], string[]][] = [];
  const closes: number[] = [];
  let announced = !opts.sessionless;
  const open = vi.fn((o: { verifyUrls: readonly string[] }, handlers: VerifyBatchStreamHandlers) => {
    const i = opened.push(handlers) - 1;
    sets.push([...o.verifyUrls]);
    return {
      sessionId: undefined,
      update: (add: readonly string[], remove: readonly string[] = []) => {
        if (!announced) throw new Error("Batch stream has not yet announced its session");
        updates.push([[...add], [...remove]]);
      },
      close: () => { closes.push(i); handlers.onClose?.(); },
    };
  });
  return { open, opened, sets, updates, closes, announce: () => { announced = true; } };
}

const BATCH = "https://x/lnurl/verifyBatch";
const A = "https://x/lnurl/verify/aa";
const B = "https://x/lnurl/verify/bb";
const settledStatus = { kind: "bolt11", settled: true, preimage: "00", pr: "lnbc1" } as const;
const pendingStatus = { kind: "bolt11", settled: false, preimage: null, pr: "lnbc1" } as const;
const handlers = () => ({ settled: vi.fn(), gaveUp: vi.fn() });

describe("settlementWatcher", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("watches two invoices on one stream, adding the second in place", () => {
    const { open, sets, updates } = fakeOpener();
    const onChange = vi.fn();
    const w = settlementWatcher({ verifyBatchUrl: BATCH, open, onChange });
    w.add(A, handlers());
    w.add(B, handlers());
    expect(open).toHaveBeenCalledOnce();
    expect(sets).toEqual([[A]]);
    expect(updates).toEqual([[[B], []]]);
    expect(onChange).toHaveBeenLastCalledWith({ pending: 2, connected: true });
  });

  it("removes a settled invoice from the stream and keeps watching the rest", () => {
    const { open, opened, updates } = fakeOpener();
    const a = handlers();
    const b = handlers();
    const w = settlementWatcher({ verifyBatchUrl: BATCH, open });
    w.add(A, a);
    w.add(B, b);
    opened[0]!.onUpdate?.(A, settledStatus);
    expect(a.settled).toHaveBeenCalledOnce();
    expect(b.settled).not.toHaveBeenCalled();
    expect(updates).toContainEqual([[], [A]]);
    expect(w.pending()).toBe(1);
  });

  it("reopens a closed stream over only the still-pending set", async () => {
    const { open, opened, sets } = fakeOpener();
    const b = handlers();
    const w = settlementWatcher({ verifyBatchUrl: BATCH, open });
    w.add(A, handlers());
    w.add(B, b);
    opened[0]!.onUpdate?.(A, settledStatus);
    opened[0]!.onClose?.();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sets).toEqual([[A], [B]]);
    opened[1]!.onUpdate?.(B, settledStatus);
    expect(b.settled).toHaveBeenCalledOnce();
  });

  it("does not reopen once nothing is pending, and opens afresh for the next add", async () => {
    const { open, opened, sets, updates } = fakeOpener();
    const w = settlementWatcher({ verifyBatchUrl: BATCH, open });
    w.add(A, handlers());
    opened[0]!.onUpdate?.(A, settledStatus);
    // The server closes a stream once all of it is settled, so the last URL is never removed by update.
    expect(updates).toEqual([]);
    opened[0]!.onClose?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(open).toHaveBeenCalledOnce();
    w.add(B, handlers());
    expect(sets).toEqual([[A], [B]]);
  });

  it("holds an add made before the session is announced until the next frame", () => {
    const { open, opened, updates, announce } = fakeOpener({ sessionless: true });
    const w = settlementWatcher({ verifyBatchUrl: BATCH, open });
    w.add(A, handlers());
    w.add(B, handlers());
    expect(updates).toEqual([]);
    announce();
    opened[0]!.onUpdate?.(A, pendingStatus);
    expect(updates).toEqual([[[B], []]]);
    expect(open).toHaveBeenCalledOnce();
  });

  it("does not reopen once stopped, and closes the live stream", async () => {
    const { open, closes } = fakeOpener();
    const w = settlementWatcher({ verifyBatchUrl: BATCH, open });
    w.add(A, handlers());
    w.stop();
    expect(closes).toEqual([0]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(open).toHaveBeenCalledOnce();
  });

  it("gives up at the deadline with the last stream error", async () => {
    const { open, opened } = fakeOpener();
    const a = handlers();
    settlementWatcher({ verifyBatchUrl: BATCH, open, timeoutMs: 5_000 }).add(A, a);
    for (let i = 0; i < 10 && a.gaveUp.mock.calls.length === 0; i++) {
      const h = opened[opened.length - 1]!;
      h.onError?.(new Error("Bad Request"));
      h.onClose?.();
      await vi.advanceTimersByTimeAsync(4_000);
    }
    expect(a.gaveUp).toHaveBeenCalledWith("Bad Request");
  });
});
