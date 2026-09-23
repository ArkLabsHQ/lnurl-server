import { describe, it, expect, vi, afterEach } from "vitest";
import { DbSettlementStore, MemorySettlementStore } from "../src/settlement-store.js";
import { settleOfflineSwaps, startOfflineSettlementPoller } from "../src/offline-poller.js";
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

    const creator = creatorReporting(["swap-1"]);
    creator.prune = vi.fn(async () => {});
    creator.release = vi.fn(async () => {});
    const n = await settleOfflineSwaps(store, creator);

    expect(n).toBe(1);
    expect(store.get("aa")).toMatchObject({ settled: true, preimage: "beef" });
    expect(store.get("bb")!.settled).toBe(false);
    expect(store.listPendingSwaps().map((p) => p.swapId)).toEqual(["swap-2"]);
    expect(creator.prune).toHaveBeenCalledWith(["swap-1", "swap-2"]);
    expect(creator.release).toHaveBeenCalledWith("swap-1");
  });

  it("claims the lockup before checking status, since the claim is what makes the solver settle", async () => {
    const store = new MemorySettlementStore(60_000);
    store.create({ paymentHash: "aa", pr: "lnbc1", sessionId: "offline:1", preimage: "beef", swapId: "swap-1" });
    const calls: [string, string][] = [];
    const log = vi.spyOn(console, "info").mockImplementation(() => {});

    const n = await settleOfflineSwaps(store, {
      ...creatorReporting(["swap-1"]),
      selfClaim: async (swapId, preimage) => {
        calls.push([swapId, preimage]);
        return { state: "claimed", arkTxid: "ark-tx-1" };
      },
    });

    expect(calls).toEqual([["swap-1", "beef"]]);
    expect(n).toBe(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"event":"offline_swap_self_claimed"'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("ark-tx-1"));
  });

  it("stops the pass when a claim it already made cannot be checkpointed", async () => {
    const store = new MemorySettlementStore(60_000);
    store.create({ paymentHash: "aa", pr: "lnbc1", sessionId: "offline:1", preimage: "beef", swapId: "swap-1" });
    store.create({ paymentHash: "bb", pr: "lnbc2", sessionId: "offline:2", preimage: "feed", swapId: "swap-2" });
    vi.spyOn(console, "info").mockImplementation(() => {});
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const claimed: string[] = [];

    const n = await settleOfflineSwaps(
      store,
      {
        ...creatorReporting(["swap-1", "swap-2"]),
        selfClaim: async (swapId) => { claimed.push(swapId); return { state: "claimed", arkTxid: `ark-${swapId}` }; },
      },
      undefined,
      undefined,
      { barrier: () => Promise.reject(new Error("checkpoint failed: enclave storage is down")) },
    );

    // The first claim already moved funds and is unrecorded; the second must not follow.
    expect(claimed).toEqual(["swap-1"]);
    expect(n).toBe(0);
    expect(store.get("bb")!.settled).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"event":"offline_swap_claim_not_durable"'));
  });

  it("starts no claim while the checkpoint store cannot commit its result", async () => {
    const store = new MemorySettlementStore(60_000);
    store.create({ paymentHash: "aa", pr: "lnbc1", sessionId: "offline:1", preimage: "beef", swapId: "swap-1" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const claimed: string[] = [];

    const n = await settleOfflineSwaps(
      store,
      {
        ...creatorReporting(["swap-1"]),
        selfClaim: async (swapId) => { claimed.push(swapId); return { state: "claimed", arkTxid: `ark-${swapId}` }; },
      },
      undefined,
      undefined,
      { barrier: async () => {}, writable: () => false },
    );

    expect(claimed).toEqual([]);
    // What the solver already did is still recorded; that moves no funds.
    expect(n).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"event":"offline_swap_claims_paused"'));
  });

  it("settles from its own claim without asking the solver to confirm it", async () => {
    const store = new MemorySettlementStore(60_000);
    store.create({ paymentHash: "aa", pr: "lnbc1", sessionId: "offline:1", preimage: "beef", swapId: "swap-1" });
    vi.spyOn(console, "info").mockImplementation(() => {});
    const creator = { ...creatorReporting([]), selfClaim: async () => ({ state: "claimed" as const, arkTxid: "ark-tx-1" }) };
    const isSettled = vi.spyOn(creator, "isSettled");

    const n = await settleOfflineSwaps(store, creator);

    expect(isSettled).not.toHaveBeenCalled();
    expect(n).toBe(1);
    expect(store.get("aa")).toMatchObject({ settled: true, preimage: "beef", payoutReference: "ark-tx-1" });
  });

  it("still asks the solver when the claim could not resolve the swap", async () => {
    const store = new MemorySettlementStore(60_000);
    store.create({ paymentHash: "aa", pr: "lnbc1", sessionId: "offline:1", preimage: "beef", swapId: "swap-1" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const creator = { ...creatorReporting(["swap-1"]), selfClaim: async () => ({ state: "skipped" as const, reason: "unfunded" as const }) };
    const isSettled = vi.spyOn(creator, "isSettled");

    expect(await settleOfflineSwaps(store, creator)).toBe(1);
    expect(isSettled).toHaveBeenCalledOnce();
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
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"event":"offline_swap_self_claim_failed"'));
  });

  it("warns rather than revealing the preimage for an underfunded lockup", async () => {
    const store = new MemorySettlementStore(60_000);
    store.create({ paymentHash: "aa", pr: "lnbc1", sessionId: "offline:1", preimage: "beef", swapId: "swap-1" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await settleOfflineSwaps(store, {
      ...creatorReporting([]),
      selfClaim: async () => ({ state: "skipped", reason: "underfunded" }),
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"event":"offline_swap_underfunded"'));
  });

  it("names a passed refund deadline distinctly from a lockup that is merely unfunded", async () => {
    const store = new MemorySettlementStore(60_000);
    store.create({ paymentHash: "aa", pr: "lnbc1", sessionId: "offline:1", preimage: "beef", swapId: "swap-1" });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await settleOfflineSwaps(store, {
      ...creatorReporting([]),
      selfClaim: async () => ({ state: "skipped", reason: "expired" }),
    });

    expect(error).toHaveBeenCalledWith(expect.stringContaining('"event":"offline_swap_refund_deadline_passed"'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("swap-1"));
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
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"event":"offline_swap_status_failed"'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("swap-1"));
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

describe("startOfflineSettlementPoller", () => {
  const pendingStore = () => {
    const store = new MemorySettlementStore(60_000);
    store.create({ paymentHash: "aa", pr: "lnbc1", sessionId: "offline:1", preimage: "beef", swapId: "swap-1" });
    return store;
  };

  /** A creator whose status check only resolves when the test says so. */
  const gatedCreator = () => {
    const gates: Array<() => void> = [];
    const creator: OfflineSwapCreator = {
      create: async () => { throw new Error("not used"); },
      isSettled: async () => {
        await new Promise<void>((resolve) => gates.push(resolve));
        return false;
      },
    };
    return { creator, gates, release: () => gates.splice(0).forEach((g) => g()) };
  };

  it("runs a pass immediately, so a lockup funded while the process was down is not held for an interval", async () => {
    const store = pendingStore();
    const creator = creatorReporting(["swap-1"]);

    const poller = startOfflineSettlementPoller(store, creator, 15_000);
    await vi.waitFor(() => expect(store.get("aa")!.settled).toBe(true));

    poller.stop();
  });

  it("settles on a funding trigger without waiting for the interval", async () => {
    const store = pendingStore();
    const settledIds: string[] = [];
    const creator = creatorReporting(settledIds);

    const poller = startOfflineSettlementPoller(store, creator, 15_000);
    await vi.waitFor(() => expect(store.get("aa")!.settled).toBe(false));

    settledIds.push("swap-1");
    poller.trigger();
    await vi.waitFor(() => expect(store.get("aa")!.settled).toBe(true));

    poller.stop();
  });

  // Two concurrent passes would each see an unspent lockup and push the same claim.
  it("never runs two passes at once", async () => {
    const store = pendingStore();
    const { creator, gates, release } = gatedCreator();

    const poller = startOfflineSettlementPoller(store, creator, 15_000);
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    poller.trigger();
    poller.trigger();
    expect(gates).toHaveLength(1);

    release();
    poller.stop();
  });

  it("queues a trigger that lands mid-pass instead of dropping it", async () => {
    const store = pendingStore();
    const { creator, gates, release } = gatedCreator();
    const isSettled = vi.spyOn(creator, "isSettled");

    const poller = startOfflineSettlementPoller(store, creator, 15_000);
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    poller.trigger();
    gates.splice(0)[0]!();

    await vi.waitFor(() => expect(isSettled).toHaveBeenCalledTimes(2));
    release();
    poller.stop();
  });

  it("stops passing once stopped", async () => {
    const store = pendingStore();
    const creator = creatorReporting([]);
    const isSettled = vi.spyOn(creator, "isSettled");

    const poller = startOfflineSettlementPoller(store, creator, 15_000);
    await vi.waitFor(() => expect(isSettled).toHaveBeenCalledTimes(1));

    poller.stop();
    poller.trigger();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(isSettled).toHaveBeenCalledTimes(1);
  });
});
