import { describe, it, expect, vi, afterEach } from "vitest";
import { DbSettlementStore, MemorySettlementStore } from "../src/settlement-store.js";
import { settleOfflineSwaps, startOfflineSettlementPoller } from "../src/workers/offline-poller.js";
import type { OfflineSwapCreator } from "../src/services/offline-swaps.js";
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
      selfClaim: async () => ({ state: "skipped", reason: "expired", funded: true }),
    });

    expect(error).toHaveBeenCalledWith(expect.stringContaining('"event":"offline_swap_refund_deadline_passed"'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("swap-1"));
  });

  it("logs an invoice nobody paid, past its deadline, at info rather than as an error", async () => {
    const store = new MemorySettlementStore(60_000);
    store.create({ paymentHash: "aa", pr: "lnbc1", sessionId: "offline:1", preimage: "beef", swapId: "swap-1" });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await settleOfflineSwaps(store, {
      ...creatorReporting([]),
      selfClaim: async () => ({ state: "skipped", reason: "expired", funded: false }),
    });

    expect(info).toHaveBeenCalledWith(expect.stringContaining('"event":"offline_swap_expired_unpaid"'));
    expect(error).not.toHaveBeenCalled();
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

  it("names a real swap id by a prefix the logger does not redact", async () => {
    const swapId = "ab".repeat(32);
    const store = new MemorySettlementStore(60_000);
    store.create({ paymentHash: "aa", pr: "lnbc1", sessionId: "offline:1", preimage: "beef", swapId });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await settleOfflineSwaps(store, { ...creatorReporting([]), isSettled: async () => { throw new Error("solver down"); } });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`"swapRef":"${swapId.slice(0, 12)}"`));
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

  it("claims the funded swap while a different catch-up row is waiting on the solver", async () => {
    const store = pendingStore();
    store.create({ paymentHash: "bb", pr: "lnbc2", sessionId: "offline:2", preimage: "feed", swapId: "swap-2" });
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const entered = vi.fn();
    const creator: OfflineSwapCreator = {
      create: async () => { throw new Error("not used"); },
      isSettled: async (swapId) => {
        if (swapId === "swap-1") { entered(); await first; return false; }
        return true;
      },
    };

    const poller = startOfflineSettlementPoller(store, creator, 15_000);
    try {
      await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
      poller.trigger("swap-2");
      await vi.waitFor(() => expect(store.get("bb")!.settled).toBe(true));
      expect(store.get("aa")!.settled).toBe(false);
    } finally {
      releaseFirst();
      poller.stop();
    }
  });

  it("retries a funding event after the same swap's in-flight check finishes", async () => {
    const store = pendingStore();
    const { creator, gates, release } = gatedCreator();
    const isSettled = vi.spyOn(creator, "isSettled");
    const poller = startOfflineSettlementPoller(store, creator, 15_000);
    try {
      await vi.waitFor(() => expect(gates).toHaveLength(1));
      poller.trigger("swap-1");
      expect(isSettled).toHaveBeenCalledTimes(1);
      gates.shift()!();
      await vi.waitFor(() => expect(isSettled).toHaveBeenCalledTimes(2));
    } finally {
      release();
      poller.stop();
    }
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

  it("reports a passed refund deadline once and stops claiming, but still asks the solver", async () => {
    const store = pendingStore();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const selfClaim = vi.fn(async () => ({ state: "skipped" as const, reason: "expired" as const, funded: true }));
    const creator: OfflineSwapCreator = { ...creatorReporting([]), selfClaim };
    const isSettled = vi.spyOn(creator, "isSettled");

    const poller = startOfflineSettlementPoller(store, creator, 15_000);
    try {
      await vi.waitFor(() => expect(isSettled).toHaveBeenCalledTimes(1));
      poller.trigger();
      await vi.waitFor(() => expect(isSettled).toHaveBeenCalledTimes(2));
      poller.trigger("swap-1");
      await vi.waitFor(() => expect(isSettled).toHaveBeenCalledTimes(3));
      expect(selfClaim).toHaveBeenCalledOnce();
      expect(error).toHaveBeenCalledOnce();
    } finally {
      poller.stop();
      error.mockRestore();
    }
  });

  it("settles from the solver's state when the creator reports one", async () => {
    const store = pendingStore();
    const creator: OfflineSwapCreator = { ...creatorReporting([]), status: async () => "settled" };

    const poller = startOfflineSettlementPoller(store, creator, 15_000);
    await vi.waitFor(() => expect(store.get("aa")!.settled).toBe(true));
    poller.stop();
  });

  it("stops asking the solver about a closed swap, but keeps claiming it until its deadline", async () => {
    const store = pendingStore();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const selfClaim = vi.fn(async () => ({ state: "skipped" as const, reason: "unfunded" as const }));
    const status = vi.fn(async () => "expired");
    const release = vi.fn(async () => {});
    const creator: OfflineSwapCreator = { ...creatorReporting([]), selfClaim, status, release };

    const poller = startOfflineSettlementPoller(store, creator, 15_000);
    try {
      await vi.waitFor(() => expect(status).toHaveBeenCalledOnce());
      poller.trigger();
      await vi.waitFor(() => expect(selfClaim).toHaveBeenCalledTimes(2));
      poller.trigger("swap-1");
      await vi.waitFor(() => expect(selfClaim).toHaveBeenCalledTimes(3));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(status).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      expect(info).toHaveBeenCalledWith(expect.stringContaining('"event":"offline_swap_closed"'));
      expect(info).toHaveBeenCalledWith(expect.stringContaining('"state":"expired"'));
    } finally {
      poller.stop();
      info.mockRestore();
    }
  });

  it("settles a closed swap that its own later claim pays out", async () => {
    const store = pendingStore();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const selfClaim = vi.fn<NonNullable<OfflineSwapCreator["selfClaim"]>>()
      .mockResolvedValueOnce({ state: "skipped", reason: "unfunded" })
      .mockResolvedValue({ state: "claimed", arkTxid: "ark-tx-1" });
    const status = vi.fn(async () => "expired");
    const creator: OfflineSwapCreator = { ...creatorReporting([]), selfClaim, status };

    const poller = startOfflineSettlementPoller(store, creator, 15_000);
    try {
      await vi.waitFor(() => expect(status).toHaveBeenCalledOnce());
      poller.trigger();
      await vi.waitFor(() => expect(store.get("aa")!.settled).toBe(true));
      expect(status).toHaveBeenCalledOnce();
    } finally {
      poller.stop();
      info.mockRestore();
    }
  });

  it("keeps asking about a swap the solver reports stuck", async () => {
    const store = pendingStore();
    const status = vi.fn(async () => "stuck");
    const creator: OfflineSwapCreator = { ...creatorReporting([]), status };

    const poller = startOfflineSettlementPoller(store, creator, 15_000);
    try {
      await vi.waitFor(() => expect(status).toHaveBeenCalledOnce());
      poller.trigger();
      await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    } finally {
      poller.stop();
    }
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
