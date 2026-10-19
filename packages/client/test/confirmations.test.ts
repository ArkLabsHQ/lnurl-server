import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { LnurlClient, VerifyStatus } from "../src/index.js";
import { createLnurlClient } from "../src/index.js";
import { CONFIRMATION_TIMEOUT_MS, createPendingConfirmations } from "../src/confirmations.js";
import { INVOICE, PREIMAGE, buildInvoice } from "./invoice.js";

const settled = (over: Partial<VerifyStatus> = {}): VerifyStatus => ({ kind: "destination", settled: true, paymentOption: "ark", ...over }) as VerifyStatus;
const fakeClient = (over: Partial<LnurlClient> = {}): LnurlClient => ({
  batchVerify: vi.fn().mockResolvedValue({ results: {} }),
  pollVerify: vi.fn().mockResolvedValue(settled()),
  ...over,
}) as unknown as LnurlClient;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("pendingConfirmations", () => {
  it("expires a queued endpoint before requesting it after a slow earlier batch", async () => {
    let release!: (result: { results: {} }) => void;
    const batchVerify = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockResolvedValue({ results: { "b/1": { kind: "verify", status: settled() } } });
    const confirmations = createPendingConfirmations(fakeClient({ batchVerify }));
    const onSettled = vi.fn();
    const onError = vi.fn();
    confirmations.add({ verifyUrl: "a/1", verifyBatch: "a/batch", onSettled: vi.fn(), onError: vi.fn() });
    confirmations.add({ verifyUrl: "b/1", verifyBatch: "b/batch", timeoutMs: 4000, onSettled, onError });
    await vi.advanceTimersByTimeAsync(7000);
    release({ results: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(batchVerify).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledExactlyOnceWith(new Error("receiver did not confirm settlement in time"));
    expect(onSettled).not.toHaveBeenCalled();
    confirmations.forget();
  });

  it("rejects a solo answer received after its deadline between sweep ticks", async () => {
    let release!: (status: VerifyStatus) => void;
    const pollVerify = vi.fn(() => new Promise<VerifyStatus>((resolve) => { release = resolve; }));
    const confirmations = createPendingConfirmations(fakeClient({ pollVerify }));
    const onSettled = vi.fn();
    const onError = vi.fn();
    confirmations.add({ verifyUrl: "solo", timeoutMs: 3000, onSettled, onError });
    await vi.advanceTimersByTimeAsync(3500);
    release(settled());
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledExactlyOnceWith(new Error("receiver did not confirm settlement in time"));
    expect(onSettled).not.toHaveBeenCalled();
  });
  it("uses the injected client transport for batched confirmations", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ results: {
        "https://a/verify/1": { status: "OK", settled: true, paymentOption: "ark", paymentDestination: "ark1expected" },
      } }), { status: 200 }));
    const confirmations = createPendingConfirmations(createLnurlClient({ fetchImpl }));
    const onSettled = vi.fn();
    const onError = vi.fn();
    confirmations.add({ verifyUrl: "https://a/verify/1", verifyBatch: "https://a/batch", expect: { paymentOption: "ark", paymentDestination: "ark1expected" }, onSettled, onError });
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(settled({ paymentDestination: "ark1expected" }));
    expect(onError).not.toHaveBeenCalled();
    confirmations.forget();
  });
  it("rejects another invoice with a valid preimage from the real batch parser", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ results: {
        "https://a/verify/1": { status: "OK", settled: true, pr: INVOICE, preimage: PREIMAGE },
      } }), { status: 200 }));
    const confirmations = createPendingConfirmations(createLnurlClient({ fetchImpl }));
    const onError = vi.fn();
    const onSettled = vi.fn();
    confirmations.add({ verifyUrl: "https://a/verify/1", verifyBatch: "https://a/batch", expect: { pr: buildInvoice("00".repeat(32)) }, onSettled, onError });
    await vi.advanceTimersByTimeAsync(2000);
    expect(onError).toHaveBeenCalledExactlyOnceWith(new Error("verify answered about a different payment"));
    expect(onSettled).not.toHaveBeenCalled();
    confirmations.forget();
  });
  it("sends one batchVerify per endpoint per tick covering every pending entry there", async () => {
    const batchVerify = vi.fn().mockResolvedValue({ results: {} });
    const confirmations = createPendingConfirmations(fakeClient({ batchVerify }));
    const onSettled = vi.fn();
    const onError = vi.fn();
    confirmations.add({ verifyUrl: "https://a/verify/1", verifyBatch: "https://a/batch", onSettled, onError });
    confirmations.add({ verifyUrl: "https://a/verify/2", verifyBatch: "https://a/batch", onSettled, onError });
    await vi.advanceTimersByTimeAsync(2000);
    expect(batchVerify).toHaveBeenCalledTimes(1);
    expect(batchVerify).toHaveBeenCalledWith("https://a/batch", ["https://a/verify/1", "https://a/verify/2"], {
      signal: expect.any(AbortSignal),
    });
  });
  it("ignores a verify URL it is already waiting on", async () => {
    const batchVerify = vi.fn().mockResolvedValue({ results: {} });
    const confirmations = createPendingConfirmations(fakeClient({ batchVerify }));
    const entry = {
      verifyUrl: "https://a/verify/1",
      verifyBatch: "https://a/batch",
      onSettled: vi.fn(),
      onError: vi.fn(),
    };
    confirmations.add(entry);
    confirmations.add({ ...entry });
    await vi.advanceTimersByTimeAsync(2000);
    expect(batchVerify).toHaveBeenCalledWith("https://a/batch", ["https://a/verify/1"], {
      signal: expect.any(AbortSignal),
    });
  });
  it("marks an entry settled from its batch answer and drops it from later ticks", async () => {
    const batchVerify = vi
      .fn()
      .mockResolvedValueOnce({ results: { "v/1": { kind: "verify", status: settled() } } })
      .mockResolvedValue({ results: {} });
    const confirmations = createPendingConfirmations(fakeClient({ batchVerify }));
    const onSettled = vi.fn();
    confirmations.add({ verifyUrl: "v/1", verifyBatch: "https://a/batch", onSettled, onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(2000);
    expect(onSettled).toHaveBeenCalledWith(settled());
    await vi.advanceTimersByTimeAsync(2000);
    expect(batchVerify).toHaveBeenCalledTimes(1);
  });
  it("fails an entry whose batch answer is a per-item error", async () => {
    const batchVerify = vi
      .fn()
      .mockResolvedValue({ results: { "v/1": { kind: "error", reason: "unknown verify url" } } });
    const confirmations = createPendingConfirmations(fakeClient({ batchVerify }));
    const onError = vi.fn();
    confirmations.add({ verifyUrl: "v/1", verifyBatch: "https://a/batch", onSettled: vi.fn(), onError });
    await vi.advanceTimersByTimeAsync(2000);
    expect(onError).toHaveBeenCalledWith(new Error("unknown verify url"));
  });
  it("retries an unreachable endpoint every tick and only fails at the deadline", async () => {
    const batchVerify = vi.fn().mockRejectedValue(new Error("network error"));
    const confirmations = createPendingConfirmations(fakeClient({ batchVerify }));
    const onError = vi.fn();
    confirmations.add({
      verifyUrl: "v/1",
      verifyBatch: "https://a/batch",
      onSettled: vi.fn(),
      onError,
    });
    await vi.advanceTimersByTimeAsync(CONFIRMATION_TIMEOUT_MS - 2000);
    expect(onError).not.toHaveBeenCalled();
    expect(batchVerify).toHaveBeenCalledTimes(CONFIRMATION_TIMEOUT_MS / 2000 - 1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(onError).toHaveBeenCalledWith(new Error("receiver did not confirm settlement in time"));
    const callsAtFailure = batchVerify.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4000);
    expect(batchVerify).toHaveBeenCalledTimes(callsAtFailure);
  });
  it("cuts off a batch request held open, so later ticks and the deadline still run", async () => {
    const batchVerify = vi.fn((_endpoint: string, _urls: readonly string[], opts?: {
      signal?: AbortSignal;
    }) => new Promise<never>((_, reject) => opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    const confirmations = createPendingConfirmations(fakeClient({ batchVerify } as Partial<LnurlClient>));
    const onError = vi.fn();
    confirmations.add({ verifyUrl: "v/1", verifyBatch: "https://a/batch", onSettled: vi.fn(), onError });
    await vi.advanceTimersByTimeAsync(CONFIRMATION_TIMEOUT_MS + 2000);
    expect(batchVerify.mock.calls.length).toBeGreaterThan(1);
    expect(onError).toHaveBeenCalledWith(new Error("receiver did not confirm settlement in time"));
  });
  it("keeps a resumed wait to the window its send started, rather than a fresh one", async () => {
    const batchVerify = vi.fn().mockRejectedValue(new Error("network error"));
    const confirmations = createPendingConfirmations(fakeClient({ batchVerify }));
    const onError = vi.fn();
    const startedAt = Date.now() - (CONFIRMATION_TIMEOUT_MS - 10000);
    confirmations.add({ verifyUrl: "v/1", verifyBatch: "https://a/batch", onSettled: vi.fn(), onError, startedAt });
    await vi.advanceTimersByTimeAsync(8000);
    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(onError).toHaveBeenCalledWith(new Error("receiver did not confirm settlement in time"));
  });
  it("falls back to pollVerify for an entry with no verifyBatch endpoint", async () => {
    const pollVerify = vi.fn().mockResolvedValue(settled());
    const confirmations = createPendingConfirmations(fakeClient({ pollVerify }));
    const onSettled = vi.fn();
    confirmations.add({ verifyUrl: "v/solo", onSettled, onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(2000);
    expect(pollVerify).toHaveBeenCalledTimes(1);
    expect(pollVerify).toHaveBeenCalledWith("v/solo", expect.objectContaining({ intervalMs: 2000 }));
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledWith(settled()));
    await vi.advanceTimersByTimeAsync(2000);
    expect(pollVerify).toHaveBeenCalledTimes(1);
  });
  it("reports a pollVerify rejection as this entry failing, not the whole tick", async () => {
    const pollVerify = vi.fn().mockRejectedValue(new Error("timed out"));
    const confirmations = createPendingConfirmations(fakeClient({ pollVerify }));
    const onError = vi.fn();
    confirmations.add({ verifyUrl: "v/solo", onSettled: vi.fn(), onError });
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(new Error("timed out")));
  });
  it("forget stops the shared loop and silences answers already in flight", async () => {
    const unsettled = { kind: "destination", settled: false, paymentOption: "ark" } as VerifyStatus;
    const batchVerify = vi.fn().mockResolvedValue({ results: { "v/1": { kind: "verify", status: unsettled } } });
    let resolvePoll: (s: VerifyStatus) => void = () => { };
    const pollVerify = vi.fn(() => new Promise<VerifyStatus>((resolve) => (resolvePoll = resolve)));
    const confirmations = createPendingConfirmations(fakeClient({ batchVerify, pollVerify }));
    const onSettledBatch = vi.fn();
    const onSettledSolo = vi.fn();
    confirmations.add({ verifyUrl: "v/1", verifyBatch: "https://a/batch", onSettled: onSettledBatch, onError: vi.fn() });
    confirmations.add({ verifyUrl: "v/solo", onSettled: onSettledSolo, onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(2000);
    confirmations.forget();
    resolvePoll(settled());
    await vi.advanceTimersByTimeAsync(10000);
    expect(onSettledBatch).not.toHaveBeenCalled();
    expect(onSettledSolo).not.toHaveBeenCalled();
    expect(batchVerify).toHaveBeenCalledTimes(1);
  });
  it("groups distinct endpoints separately and never overlaps a slow tick", async () => {
    let resolveBatch!: (value: {
      results: {};
    }) => void;
    const batchVerify = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveBatch = resolve; }))
      .mockResolvedValue({ results: {} });
    const confirmations = createPendingConfirmations(fakeClient({ batchVerify }));
    for (const endpoint of ["a", "b"]) {
      confirmations.add({ verifyUrl: `${endpoint}/1`, verifyBatch: `${endpoint}/batch`, onSettled: vi.fn(), onError: vi.fn() });
    }
    await vi.advanceTimersByTimeAsync(6000);
    expect(batchVerify).toHaveBeenCalledTimes(1);
    resolveBatch({ results: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(batchVerify).toHaveBeenCalledTimes(2);
    expect(batchVerify).toHaveBeenLastCalledWith("b/batch", ["b/1"], { signal: expect.any(AbortSignal) });
    confirmations.forget();
  });
  it("keeps progressing when a batch transport ignores abort", async () => {
    const batchVerify = vi.fn().mockImplementation(() => new Promise(() => { }));
    const confirmations = createPendingConfirmations(fakeClient({ batchVerify }));
    const onError = vi.fn();
    confirmations.add({ verifyUrl: "v/1", verifyBatch: "https://a/batch", onSettled: vi.fn(), onError });
    await vi.advanceTimersByTimeAsync(CONFIRMATION_TIMEOUT_MS + 2000);
    expect(batchVerify.mock.calls.length).toBeGreaterThan(1);
    expect(onError).toHaveBeenCalledExactlyOnceWith(new Error("receiver did not confirm settlement in time"));
  });
  it("times out a stalled solo poll using its original send deadline", async () => {
    const pollVerify = vi.fn().mockImplementation(() => new Promise(() => { }));
    const confirmations = createPendingConfirmations(fakeClient({ pollVerify }));
    const onError = vi.fn();
    confirmations.add({ verifyUrl: "v/solo", startedAt: Date.now() - 8000, timeoutMs: 12000, onSettled: vi.fn(), onError });
    await vi.advanceTimersByTimeAsync(4000);
    expect(pollVerify).toHaveBeenCalledWith("v/solo", expect.objectContaining({ timeoutMs: 2000 }));
    expect(onError).toHaveBeenCalledExactlyOnceWith(new Error("receiver did not confirm settlement in time"));
  });
  it.each([true, false])("rejects a foreign batch payment even when settled is %s", async (isSettled) => {
    const batchVerify = vi.fn().mockResolvedValue({ results: { "v/1": { kind: "verify", status: settled({ settled: isSettled }) } } });
    const confirmations = createPendingConfirmations(fakeClient({ batchVerify }));
    const onError = vi.fn();
    const onSettled = vi.fn();
    confirmations.add({ verifyUrl: "v/1", verifyBatch: "https://a/batch", expect: { pr: INVOICE }, onSettled, onError });
    await vi.advanceTimersByTimeAsync(2000);
    expect(onError).toHaveBeenCalledExactlyOnceWith(new Error("verify answered about a different payment"));
    expect(onSettled).not.toHaveBeenCalled();
  });
  it("passes the expected destination to solo polls and rejects a foreign answer", async () => {
    const pollVerify = vi.fn().mockResolvedValue(settled({ paymentDestination: "ark1wrong" }));
    const confirmations = createPendingConfirmations(fakeClient({ pollVerify }));
    const expected = { paymentOption: "ark", paymentDestination: "ark1expected" };
    const onError = vi.fn();
    const onSettled = vi.fn();
    confirmations.add({ verifyUrl: "v/solo", expect: expected, onSettled, onError });
    await vi.advanceTimersByTimeAsync(2000);
    expect(pollVerify).toHaveBeenCalledWith("v/solo", expect.objectContaining({ expect: expected }));
    expect(onError).toHaveBeenCalledExactlyOnceWith(new Error("verify answered about a different payment"));
    expect(onSettled).not.toHaveBeenCalled();
  });
  it("isolates throwing callbacks from other entries and later deadlines", async () => {
    const batchVerify = vi.fn().mockResolvedValue({ results: {
        "v/1": { kind: "verify", status: settled() },
        "v/2": { kind: "verify", status: settled() },
      } });
    const confirmations = createPendingConfirmations(fakeClient({ batchVerify }));
    const onSettled = vi.fn();
    confirmations.add({ verifyUrl: "v/1", verifyBatch: "https://a/batch", onSettled: () => { throw new Error("consumer failed"); }, onError: vi.fn() });
    confirmations.add({ verifyUrl: "v/2", verifyBatch: "https://a/batch", onSettled, onError: vi.fn() });
    confirmations.add({ verifyUrl: "v/3", timeoutMs: 1, onSettled: vi.fn(), onError: () => { throw new Error("consumer failed"); } });
    await vi.advanceTimersByTimeAsync(4000);
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(settled());
    expect(batchVerify).toHaveBeenCalledTimes(1);
  });
  it("silences a forgotten in-flight batch without blocking a new wait", async () => {
    let resolveOld!: (value: unknown) => void;
    const batchVerify = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValue({ results: { "v/new": { kind: "verify", status: settled() } } });
    const confirmations = createPendingConfirmations(fakeClient({ batchVerify }));
    const onOldSettled = vi.fn();
    const onOldError = vi.fn();
    const onNewSettled = vi.fn();
    confirmations.add({ verifyUrl: "v/old", verifyBatch: "https://a/batch", onSettled: onOldSettled, onError: onOldError });
    await vi.advanceTimersByTimeAsync(2000);
    confirmations.forget();
    confirmations.add({ verifyUrl: "v/new", verifyBatch: "https://a/batch", onSettled: onNewSettled, onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(2000);
    resolveOld({ results: { "v/old": { kind: "verify", status: settled() } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(onOldSettled).not.toHaveBeenCalled();
    expect(onOldError).not.toHaveBeenCalled();
    expect(onNewSettled).toHaveBeenCalledExactlyOnceWith(settled());
  });
});
