import { describe, expect, it, vi } from "vitest";
import { LnurlError } from "../src/errors.js";
import type { LnurlClient } from "../src/index.js";
import { syncPayments } from "../src/sync.js";
import type { PaymentSyncStore, PaymentSyncTarget, StoredPayment } from "../src/sync.js";
import type { Bolt11Activity, DestinationActivity, PaymentActivity, PaymentPage } from "../src/types.js";

const SERVER_A = "https://lnurl-a.test";
const SERVER_B = "https://lnurl-b.test";
const DOMAIN = "example.com";

const targetA: PaymentSyncTarget = { baseUrl: SERVER_A, token: "token-a", username: "alice", domain: DOMAIN };
const targetB: PaymentSyncTarget = { baseUrl: SERVER_B, token: "token-b", username: "bob", domain: DOMAIN };
const addressOf = (target: PaymentSyncTarget): string => `${target.username}@${target.domain}`;

const makeBolt11 = (paymentHash: string, createdAt: number): Bolt11Activity => ({
  kind: "bolt11",
  paymentHash,
  pr: "lnbc10n1ptest",
  preimage: null,
  swapId: null,
  settled: false,
  amountMsat: 21000,
  createdAt,
  settledAt: null,
});

const makeDestination = (
  verifyId: string,
  createdAt: number,
  paymentReference: string | null = null,
): DestinationActivity => ({
  kind: "destination",
  verifyId,
  paymentOption: "arkade",
  paymentDestination: "ark1qptest",
  covenantScript: null,
  paymentReference,
  settled: false,
  amountMsat: 42000,
  createdAt,
  settledAt: null,
});

const makePage = (target: PaymentSyncTarget, payments: PaymentActivity[], nextSince: number): PaymentPage => ({
  source: { domain: target.domain, lightningAddress: addressOf(target) },
  payments,
  nextSince,
});

interface MemoryStore extends PaymentSyncStore {
  all(): StoredPayment[];
}

const createMemoryStore = (): MemoryStore => {
  const records = new Map<string, StoredPayment>();
  const watermarks = new Map<string, number>();
  return {
    upsert: async (next) => {
      for (const record of next) records.set(record.key, record);
    },
    readWatermark: async (baseUrl, lightningAddress) => watermarks.get(`${baseUrl}|${lightningAddress}`),
    writeWatermark: async (baseUrl, lightningAddress, since) => {
      watermarks.set(`${baseUrl}|${lightningAddress}`, since);
    },
    all: () => [...records.values()],
  };
};

type ListPayments = Pick<LnurlClient, "listPayments">;

describe("syncPayments", () => {
  it("requests another page after a full page and stops after a short page", async () => {
    const full = Array.from({ length: 50 }, (_, index) => makeBolt11(`hash-${index}`, 1000 + index));
    const listPayments = vi
      .fn<ListPayments["listPayments"]>()
      .mockResolvedValueOnce(makePage(targetA, full, 1050))
      .mockResolvedValueOnce(makePage(targetA, [makeBolt11("hash-50", 1050)], 1051));
    const store = createMemoryStore();

    const result = await syncPayments([targetA], { client: () => ({ listPayments }), store });

    expect(listPayments).toHaveBeenCalledTimes(2);
    expect(listPayments).toHaveBeenNthCalledWith(1, "token-a", "alice", { domain: DOMAIN, since: undefined, limit: 50 });
    expect(listPayments).toHaveBeenNthCalledWith(2, "token-a", "alice", { domain: DOMAIN, since: 1050, limit: 50 });
    expect(result).toEqual({ synced: 51, failures: [] });
    expect(await store.readWatermark(SERVER_A, addressOf(targetA))).toBe(1051);
    expect(store.all()).toHaveLength(51);
  });

  it("re-fetches the boundary row on resume without duplicating it", async () => {
    const entry = makeBolt11("hash-1", 1042);
    const listPayments = vi.fn<ListPayments["listPayments"]>(async (_token, _username, opts) =>
      makePage(targetA, [entry], opts?.since ?? 1042),
    );
    const store = createMemoryStore();

    await syncPayments([targetA], { client: () => ({ listPayments }), store });
    expect(await store.readWatermark(SERVER_A, addressOf(targetA))).toBe(1042);
    await syncPayments([targetA], { client: () => ({ listPayments }), store });

    expect(listPayments).toHaveBeenNthCalledWith(2, "token-a", "alice", { domain: DOMAIN, since: 1042, limit: 50 });
    expect(store.all()).toHaveLength(1);
  });

  it("builds a client per target so a token never reaches another server", async () => {
    const seen: { baseUrl: string; token: string }[] = [];
    const client = (baseUrl: string) => ({
      listPayments: (async (token, username) => {
        seen.push({ baseUrl, token });
        return makePage(username === "alice" ? targetA : targetB, [], 0);
      }) as ListPayments["listPayments"],
    });

    await syncPayments([targetA, targetB], { client, store: createMemoryStore() });

    expect(seen).toEqual([
      { baseUrl: SERVER_A, token: "token-a" },
      { baseUrl: SERVER_B, token: "token-b" },
    ]);
  });

  it("isolates a failing target and leaves its watermark untouched", async () => {
    const listPayments = vi.fn<ListPayments["listPayments"]>(async (token) => {
      if (token === "token-a") throw new Error("connection refused");
      return makePage(targetB, [makeBolt11("hash-b", 2000)], 2000);
    });
    const store = createMemoryStore();

    const result = await syncPayments([targetA, targetB], { client: () => ({ listPayments }), store });

    expect(result.synced).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.baseUrl).toBe(SERVER_A);
    expect(await store.readWatermark(SERVER_A, addressOf(targetA))).toBeUndefined();
    expect(await store.readWatermark(SERVER_B, addressOf(targetB))).toBe(2000);
    expect(store.all()).toHaveLength(1);
  });

  it("keeps the last good cursor when a target fails mid-pagination", async () => {
    const full = Array.from({ length: 50 }, (_, index) => makeBolt11(`hash-${index}`, 1000 + index));
    const listPayments = vi
      .fn<ListPayments["listPayments"]>()
      .mockResolvedValueOnce(makePage(targetA, full, 1050))
      .mockRejectedValueOnce(new Error("connection reset"));
    const store = createMemoryStore();

    const result = await syncPayments([targetA], { client: () => ({ listPayments }), store });

    expect(result.synced).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(await store.readWatermark(SERVER_A, addressOf(targetA))).toBe(1050);
    expect(store.all()).toHaveLength(50);
  });

  it("stores destination entries under verifyId with the payment reference kept", async () => {
    const listPayments = vi
      .fn<ListPayments["listPayments"]>()
      .mockResolvedValue(makePage(targetA, [makeDestination("verify-1", 3000, "txid-9")], 3000));
    const store = createMemoryStore();

    await syncPayments([targetA], { client: () => ({ listPayments }), store });

    const all = store.all();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      key: `${SERVER_A}|verify-1`,
      baseUrl: SERVER_A,
      kind: "destination",
      identifier: "verify-1",
      paymentReference: "txid-9",
      swapId: null,
      domain: DOMAIN,
      lightningAddress: addressOf(targetA),
    });
  });

  it("stores bolt11 entries under paymentHash with the swap id carried", async () => {
    const entry: Bolt11Activity = { ...makeBolt11("hash-7", 1000), swapId: "swap-1" };
    const listPayments = vi.fn<ListPayments["listPayments"]>().mockResolvedValue(makePage(targetA, [entry], 1000));
    const store = createMemoryStore();

    await syncPayments([targetA], { client: () => ({ listPayments }), store });

    expect(store.all()[0]).toMatchObject({
      key: `${SERVER_A}|hash-7`,
      kind: "bolt11",
      identifier: "hash-7",
      swapId: "swap-1",
      paymentReference: null,
    });
  });

  it("retries a rate-limited page and then advances", async () => {
    const listPayments = vi
      .fn<ListPayments["listPayments"]>()
      .mockRejectedValueOnce(new LnurlError("rate limited", { httpStatus: 429 }))
      .mockResolvedValueOnce(makePage(targetA, [makeBolt11("hash-1", 1000)], 1000));
    const store = createMemoryStore();

    const result = await syncPayments([targetA], { client: () => ({ listPayments }), store });

    expect(listPayments).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ synced: 1, failures: [] });
    expect(await store.readWatermark(SERVER_A, addressOf(targetA))).toBe(1000);
  });

  it("fails the target instead of looping when a full page does not advance the cursor", async () => {
    const stalled = Array.from({ length: 50 }, (_, index) => makeBolt11(`hash-${index}`, 1000));
    const listPayments = vi.fn<ListPayments["listPayments"]>().mockResolvedValue(makePage(targetA, stalled, 1000));
    const store = createMemoryStore();

    const result = await syncPayments([targetA], { client: () => ({ listPayments }), store });

    expect(listPayments).toHaveBeenCalledTimes(2);
    expect(result.failures).toHaveLength(1);
    expect((result.failures[0]?.error as LnurlError).retryable).toBe(false);
    expect(store.all()).toHaveLength(50);
    expect(await store.readWatermark(SERVER_A, addressOf(targetA))).toBe(1000);
  });

  it("surfaces a terminal failure once without retrying", async () => {
    const listPayments = vi
      .fn<ListPayments["listPayments"]>()
      .mockRejectedValue(new LnurlError("forbidden", { httpStatus: 403 }));
    const store = createMemoryStore();

    const result = await syncPayments([targetA], { client: () => ({ listPayments }), store });

    expect(listPayments).toHaveBeenCalledTimes(1);
    expect(result.synced).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(await store.readWatermark(SERVER_A, addressOf(targetA))).toBeUndefined();
  });
});
