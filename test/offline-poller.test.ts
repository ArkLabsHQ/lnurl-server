import { describe, it, expect } from "vitest";
import { MemorySettlementStore } from "../src/settlement-store.js";
import { settleOfflineSwaps } from "../src/offline-poller.js";
import type { ReverseSwapCreator } from "../src/reverse-swap.js";

function creatorReporting(settledIds: string[]): ReverseSwapCreator {
  return {
    create: async () => { throw new Error("not used"); },
    isSettled: async (swapId: string) => settledIds.includes(swapId),
  };
}

describe("settleOfflineSwaps", () => {
  it("marks pending offline swaps settled once the creator reports them paid", async () => {
    const store = new MemorySettlementStore(60_000);
    store.create({ paymentHash: "aa", pr: "lnbc1", sessionId: "offline:1", preimage: "beef", swapId: "swap-1" });
    store.create({ paymentHash: "bb", pr: "lnbc2", sessionId: "offline:2", preimage: "feed", swapId: "swap-2" });

    const n = await settleOfflineSwaps(store, creatorReporting(["swap-1"]));

    expect(n).toBe(1);
    expect(store.get("aa")).toMatchObject({ settled: true, preimage: "beef" });
    expect(store.get("bb")!.settled).toBe(false);
    expect(store.listPendingSwaps().map((p) => p.swapId)).toEqual(["swap-2"]);
  });

  it("leaves a swap pending when the status check throws (transient)", async () => {
    const store = new MemorySettlementStore(60_000);
    store.create({ paymentHash: "aa", pr: "lnbc1", sessionId: "offline:1", preimage: "beef", swapId: "swap-1" });
    const creator: ReverseSwapCreator = {
      create: async () => { throw new Error("not used"); },
      isSettled: async () => { throw new Error("boltz down"); },
    };

    const n = await settleOfflineSwaps(store, creator);

    expect(n).toBe(0);
    expect(store.get("aa")!.settled).toBe(false);
  });
});
