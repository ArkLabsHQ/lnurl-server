import { describe, it, expect, vi, afterEach } from "vitest";
import { DbSettlementStore, MemorySettlementStore } from "../src/settlement-store.js";
import { settleOfflineSwaps } from "../src/offline-poller.js";
import type { OfflineSwapCreator } from "../src/intent-swap.js";
import { OfflineSwapStore } from "../src/offline-swap-store.js";
import { openDb } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";

function creatorReporting(settledIds: string[]): OfflineSwapCreator {
  return {
    create: async () => { throw new Error("not used"); },
    isSettled: async (swapId: string) => settledIds.includes(swapId),
  };
}

describe("settleOfflineSwaps", () => {
  // Unconditional, unlike a restore after the assertions: one failed expect
  // would otherwise leave console.warn mocked for every later test.
  afterEach(() => vi.restoreAllMocks());

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

  it("claims the lockup before checking status, since the claim is what makes the solver settle", async () => {
    const store = new MemorySettlementStore(60_000);
    store.create({ paymentHash: "aa", pr: "lnbc1", sessionId: "offline:1", preimage: "beef", swapId: "swap-1" });
    const calls: [string, string][] = [];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const n = await settleOfflineSwaps(store, {
      ...creatorReporting(["swap-1"]),
      selfClaim: async (swapId, preimage) => {
        calls.push([swapId, preimage]);
        return { state: "claimed", arkTxid: "ark-tx-1" };
      },
    });

    expect(calls).toEqual([["swap-1", "beef"]]);
    expect(n).toBe(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("ark-tx-1"));
  });

  it("still checks status when the claim throws, so a broken claim path cannot wedge a swap", async () => {
    const store = new MemorySettlementStore(60_000);
    store.create({ paymentHash: "aa", pr: "lnbc1", sessionId: "offline:1", preimage: "beef", swapId: "swap-1" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const n = await settleOfflineSwaps(store, {
      ...creatorReporting(["swap-1"]),
      selfClaim: async () => { throw new Error("arkd down"); },
    });

    expect(n).toBe(1);
    expect(store.get("aa")!.settled).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("self-claim failed"), expect.any(Error));
  });

  it("warns rather than revealing the preimage for an underfunded lockup", async () => {
    const store = new MemorySettlementStore(60_000);
    store.create({ paymentHash: "aa", pr: "lnbc1", sessionId: "offline:1", preimage: "beef", swapId: "swap-1" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await settleOfflineSwaps(store, {
      ...creatorReporting([]),
      selfClaim: async () => ({ state: "skipped", reason: "underfunded" }),
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("underfunded"));
  });

  it("leaves a swap pending when the status check throws, and names it in a warning", async () => {
    const store = new MemorySettlementStore(60_000);
    store.create({ paymentHash: "aa", pr: "lnbc1", sessionId: "offline:1", preimage: "beef", swapId: "swap-1" });
    const creator: OfflineSwapCreator = {
      create: async () => { throw new Error("not used"); },
      isSettled: async () => { throw new Error("solver down"); },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const n = await settleOfflineSwaps(store, creator);

    expect(n).toBe(0);
    expect(store.get("aa")!.settled).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("swap-1"), expect.any(Error));
  });

  it("drives status and self-claim from a persisted recovery row", async () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const settlements = new DbSettlementStore(db, 60_000, () => 1_001);
    const recovered = new OfflineSwapStore(db, 60_000, () => 1_000);
    recovered.createAccepted({
      paymentHash: "aa".repeat(32), pr: "lnbc1", sessionId: "offline:1", preimage: "bb".repeat(32), amountMsat: 5_000_000,
      recovery: { version: 1, solverName: "primary", solverPubkey: "11".repeat(32), relays: ["wss://relay.example"], rfqId: "22".repeat(32), lockupAddress: "tark1", expectedAmount: 4_999, script: { sender: "33".repeat(32) } },
    });
    const seen: unknown[] = [];
    const creator: OfflineSwapCreator = {
      create: async () => { throw new Error("not used"); },
      selfClaim: async (_swapId, _preimage, recovery) => { seen.push(recovery); return { state: "skipped", reason: "unfunded" }; },
      isSettled: async (_swapId, recovery) => { seen.push(recovery); return true; },
    };

    expect(await settleOfflineSwaps(settlements, creator, recovered)).toBe(1);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ solverPubkey: "11".repeat(32), relays: ["wss://relay.example"] });
    expect(settlements.get("aa".repeat(32))?.settled).toBe(true);
    db.close();
  });
});
