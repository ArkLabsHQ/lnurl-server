import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserPaymentStore, storedPayments } from "../src/stores.js";
import type { StoredPayment } from "../src/sync.js";

const record = (over: Partial<StoredPayment>): StoredPayment => ({
  key: `b|${over.identifier}`, baseUrl: "b", domain: "pay.example", lightningAddress: null, handle: "h",
  identifier: "i", kind: "bolt11", settled: true, amountMsat: 1000, createdAt: 1, settledAt: 1,
  swapId: null, paymentReference: null, payoutReference: null, preimage: null,
  ...over,
} as StoredPayment);

beforeEach(() => {
  const entries = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => entries.get(k) ?? null,
    setItem: (k: string, v: string) => void entries.set(k, v),
    removeItem: (k: string) => void entries.delete(k),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("storedPayments", () => {
  it("selects a nameless receiver's records by domain and handle", async () => {
    const sid = "0".repeat(32);
    await browserPaymentStore().upsert([
      record({ identifier: "a", handle: sid }),
      record({ identifier: "b", handle: sid, domain: "other.example" }),
      record({ identifier: "c", handle: "alice", lightningAddress: "alice@pay.example" }),
    ]);

    expect(storedPayments({ domain: "pay.example", handle: sid }).map((r) => r.identifier)).toEqual(["a"]);
    expect(storedPayments("alice@pay.example").map((r) => r.identifier)).toEqual(["c"]);
  });

  it("still finds a named address's rows synced before records carried a handle", async () => {
    const { handle: _, ...legacy } = record({ identifier: "d", lightningAddress: "alice@pay.example" });
    await browserPaymentStore().upsert([legacy as StoredPayment]);

    expect(storedPayments({ domain: "pay.example", handle: "alice" }).map((r) => r.identifier)).toEqual(["d"]);
  });
});
