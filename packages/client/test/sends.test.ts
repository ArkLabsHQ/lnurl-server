import { describe, expect, it, vi } from "vitest";
import { makeHandle, type PaymentHandle, type RouteQuote } from "@arkade-os/sdk";
import type { SentPayment } from "../src/activity.js";
import type { ReceiverConfirmation } from "../src/confirmations.js";
import { createLnurlSendTracker } from "../src/sends.js";
import { createPendingConfirmations } from "../src/confirmations.js";

const quote = (meta: Record<string, unknown> = {}): RouteQuote => ({
  railId: "lnurl-lightning", amount: 2100, fee: 70, total: 2170,
  meta: { lnurl: { target: "alice@pay.example", via: "lightning", ...meta } },
  send: async () => { throw new Error("not sent here"); },
});

function setup(initial: SentPayment[] = []) {
  let rows = initial;
  const pending: ReceiverConfirmation[] = [];
  const tracker = createLnurlSendTracker({
    read: () => rows,
    write: (next) => { rows = next; },
  }, { onError: (error) => { throw error; }, confirmations: {
    add: (entry) => { pending.push(entry); },
    forget: () => { pending.length = 0; },
  } });
  return { tracker, pending, rows: () => rows };
}

function runningSend() {
  let emit!: Parameters<PaymentHandle["subscribe"]>[0];
  const handle = makeHandle("lightning", (update) => {
    emit = update;
    return new Promise(() => {});
  });
  return { handle, emit: (update: Parameters<typeof emit>[0]) => emit(update) };
}

describe("createLnurlSendTracker", () => {
  it("marks each send sharing a verify URL while resuming only one watch per transaction", async () => {
    vi.useFakeTimers();
    const entry: SentPayment = {
      txid: "first", target: "alice@pay.example", railId: "lnurl-arkade",
      amountSat: 2100, feeSat: 0, createdAt: Date.now(), verify: "https://pay.example/v/1",
      verifyBatch: "https://pay.example/batch",
    };
    let rows = [entry, { ...entry, txid: "second" }];
    const batchVerify = vi.fn(async () => ({ results: {
      [entry.verify!]: { kind: "verify" as const, status: { kind: "destination" as const, settled: true, paymentOption: "arkade" } },
    } }));
    const confirmations = createPendingConfirmations({ batchVerify, pollVerify: async () => { throw new Error("unexpected"); } });
    const tracker = createLnurlSendTracker({ read: () => rows, write: (next) => { rows = next; } }, {
      confirmations, onError: (error) => { throw error; },
    });
    try {
      tracker.resume();
      tracker.resume();
      await vi.advanceTimersByTimeAsync(2000);
      expect(batchVerify).toHaveBeenCalledTimes(1);
      expect(rows.map((row) => row.receiverConfirmed)).toEqual([true, true]);
    } finally {
      tracker.forget();
      vi.useRealTimers();
    }
  });

  it("reports persistence failures from real terminal payment callbacks", async () => {
    const error = new Error("quota exceeded");
    const onError = vi.fn();
    const tracker = createLnurlSendTracker({
      read: () => [], write: () => { throw error; },
    }, { onError });
    const handle = makeHandle("ark", async (emit) => {
      const result = { railId: "ark", txid: "funding" };
      emit({ status: "settled", result });
      return result;
    });
    tracker.record(handle, quote(), "alice");
    await handle.settled();
    expect(onError).toHaveBeenCalledWith(error);
    tracker.forget();
  });
  it("merges the funding and settlement updates, keeping metadata and the original date", () => {
    const { tracker, rows } = setup();
    const send = runningSend();
    tracker.record(send.handle, quote({
      verify: "https://pay.example/v/1", verifyBatch: "https://pay.example/batch",
      expect: { pr: "invoice" }, quote: { amount: "500", unit: "USD", decimals: 2 },
    }), "typed-target");
    send.emit({ status: "sent", result: { railId: "lightning", txid: "funding", swapId: "swap" } });
    const createdAt = rows()[0].createdAt;
    send.emit({ status: "settled", result: { railId: "lightning", txid: "funding", preimage: "ab".repeat(32) } });
    expect(rows()).toEqual([{
      txid: "funding", target: "alice@pay.example", railId: "lnurl-lightning",
      amountSat: 2100, feeSat: 70, createdAt, swapId: "swap", preimage: "ab".repeat(32),
      verify: "https://pay.example/v/1", verifyBatch: "https://pay.example/batch",
      expect: { pr: "invoice" }, quote: { amount: "500", unit: "USD", decimals: 2 },
    }]);
  });

  it("records nothing until a payment identifies its funding transaction", () => {
    const { tracker, rows } = setup();
    const send = runningSend();
    tracker.record(send.handle, quote(), "typed-target");
    send.emit({ status: "pending" });
    expect(rows()).toEqual([]);
    tracker.forget();
  });

  it("resumes only unanswered rows with their original deadline and payment identity", () => {
    const base: SentPayment = {
      txid: "pending", target: "alice@pay.example", railId: "lnurl-arkade",
      amountSat: 2100, feeSat: 0, createdAt: 123, verify: "https://pay.example/v/1",
      expect: { paymentOption: "arkade", paymentDestination: "destination" },
    };
    const { tracker, pending, rows } = setup([
      base, { ...base, txid: "answered", receiverConfirmed: false },
      { ...base, txid: "no-verify", verify: undefined },
    ]);
    tracker.resume();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ verifyUrl: base.verify, startedAt: 123, expect: base.expect });
    pending[0].onSettled({ kind: "destination", settled: true, paymentOption: "arkade" });
    expect(rows()).toEqual([{ ...base, receiverConfirmed: true },
      { ...base, txid: "answered", receiverConfirmed: false }, { ...base, txid: "no-verify", verify: undefined }]);
  });

  it("marks failures without creating records for unknown transactions", () => {
    const { tracker, pending, rows } = setup();
    tracker.mark("unknown", false);
    expect(rows()).toEqual([]);
    const send = runningSend();
    tracker.record(send.handle, quote(), "typed-target");
    send.emit({ status: "sent", result: { railId: "lightning", txid: "funding" } });
    tracker.watch("funding", "https://pay.example/v/1");
    pending[0].onError(new Error("timeout"));
    expect(rows()[0].receiverConfirmed).toBe(false);
    tracker.forget();
  });

  it("forgets old subscriptions and callbacks before reset can clear the store", () => {
    const { tracker, pending, rows } = setup();
    const send = runningSend();
    tracker.record(send.handle, quote(), "typed-target");
    send.emit({ status: "sent", result: { railId: "lightning", txid: "funding" } });
    tracker.watch("funding", "https://pay.example/v/1");
    const oldCallback = pending[0];
    tracker.forget();
    const before = rows();
    send.emit({ status: "settled", result: { railId: "lightning", txid: "funding", preimage: "ab".repeat(32) } });
    oldCallback.onError(new Error("late response"));
    expect(rows()).toEqual(before);
    expect(rows()[0].preimage).toBeUndefined();
    expect(rows()[0].receiverConfirmed).toBeUndefined();
  });
});
