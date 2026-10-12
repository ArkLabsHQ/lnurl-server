import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserPaymentStore, forgetStoredPayments, storedPayments } from "../src/stores.js";
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
  it("refreshes legacy cached payments once to fill their destinations", async () => {
    const prefix = "test:";
    const store = browserPaymentStore(prefix);
    const cached = record({ identifier: "old", kind: "destination" });
    await store.upsert([cached]);
    localStorage.setItem(`${prefix}arkade-lnurl.watermarks`, JSON.stringify({ "b|h@pay.example": 100 }));

    expect(await store.readWatermark("b", "h@pay.example")).toBeUndefined();
    expect(storedPayments({ domain: "pay.example", handle: "h" }, prefix)).toEqual([cached]);
    await store.writeWatermark("b", "h@pay.example", 200);
    expect(await store.readWatermark("b", "h@pay.example")).toBe(200);
    forgetStoredPayments(prefix);
    expect(await store.readWatermark("b", "h@pay.example")).toBeUndefined();
    expect(localStorage.getItem(`${prefix}arkade-lnurl.watermarks`)).toBeNull();
  });

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
