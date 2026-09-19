import { describe, it, expect, vi } from "vitest";
import type { IContractManager } from "@arkade-os/sdk";
import { MemorySettlementStore } from "../src/settlement-store.js";
import { startCovenantWatcher, catchUp } from "../src/covenant-watcher.js";
import { COVENANT_CONTRACT_TYPE } from "../src/covenant-contract.js";

// Ported from the polled watcher: the properties are the rail's, not the mechanism's,
// so they must hold the same way now that settlement arrives as an event.

const storeWith = (recs: { hash: string; script: string; amountMsat: number }[]) => {
  const s = new MemorySettlementStore(3_600_000);
  for (const r of recs) {
    s.create({
      paymentHash: r.hash,
      pr: "",
      sessionId: "sess",
      paymentOption: "arkade",
      paymentDestination: `tark1for-${r.hash}`,
      amountMsat: r.amountMsat,
      covenantScript: r.script,
    });
  }
  return s;
};

const contract = (script: string) => ({ type: COVENANT_CONTRACT_TYPE, script, params: {}, address: `tark1${script}` });

/** Captures the subscriber so a test can push events the way the manager would. */
function fakeManager(funded: { script: string; vtxos: { txid: string; value: number; isSpent?: boolean }[] }[] = []) {
  let emit: ((e: unknown) => void) | undefined;
  const manager = {
    onContractEvent: vi.fn((cb: (e: unknown) => void) => {
      emit = cb;
      return () => {
        emit = undefined;
      };
    }),
    getContractsWithVtxos: vi.fn(async () => funded.map((f) => ({ contract: contract(f.script), vtxos: f.vtxos }))),
  } as unknown as IContractManager;
  const received = (script: string, vtxos: { txid: string; value: number }[]) =>
    emit?.({ type: "vtxo_received", contractScript: script, vtxos, contract: contract(script), timestamp: Date.now() });
  return { manager, received, onContractEvent: manager.onContractEvent as unknown as ReturnType<typeof vi.fn> };
}

describe("startCovenantWatcher", () => {
  // The case the static address cannot resolve: same user, same amount, both in
  // flight. Distinct scripts settle each to its own record with no guessing.
  it("attributes concurrent same-amount payments exactly", () => {
    const store = storeWith([
      { hash: "v1", script: "512011", amountMsat: 50_000 },
      { hash: "v2", script: "512022", amountMsat: 50_000 },
    ]);
    const { manager, received } = fakeManager();
    startCovenantWatcher(store, manager);

    received("512022", [{ txid: "tx-for-v2", value: 50 }]);
    received("512011", [{ txid: "tx-for-v1", value: 50 }]);

    expect(store.get("v1")).toMatchObject({ settled: true, paymentReference: "tx-for-v1" });
    expect(store.get("v2")).toMatchObject({ settled: true, paymentReference: "tx-for-v2" });
  });

  it("never lets a smaller record consume a larger record's payment", () => {
    const store = storeWith([
      { hash: "small", script: "512033", amountMsat: 1_000 },
      { hash: "large", script: "512044", amountMsat: 50_000 },
    ]);
    const { manager, received } = fakeManager();
    startCovenantWatcher(store, manager);

    received("512044", [{ txid: "tx-large", value: 50 }]);

    expect(store.get("large")).toMatchObject({ settled: true, paymentReference: "tx-large" });
    expect(store.get("small")!.settled).toBe(false);
  });

  it("still refuses an under-payment to its own script", () => {
    const store = storeWith([{ hash: "v1", script: "512011", amountMsat: 50_000 }]);
    const { manager, received } = fakeManager();
    startCovenantWatcher(store, manager);

    received("512011", [{ txid: "tx-short", value: 49 }]);

    expect(store.get("v1")!.settled).toBe(false);
  });

  it("ignores an event for a script it has no record for", () => {
    const store = storeWith([{ hash: "v1", script: "512011", amountMsat: 50_000 }]);
    const { manager, received } = fakeManager();
    startCovenantWatcher(store, manager);

    received("5120ff", [{ txid: "tx-other", value: 50 }]);

    expect(store.get("v1")!.settled).toBe(false);
  });

  it("unsubscribes when stopped", () => {
    const store = storeWith([{ hash: "v1", script: "512011", amountMsat: 50_000 }]);
    const { manager, received } = fakeManager();

    startCovenantWatcher(store, manager)();
    received("512011", [{ txid: "tx-for-v1", value: 50 }]);

    expect(store.get("v1")!.settled).toBe(false);
  });

  it("settles a payment whose event a dropped subscription never delivered", async () => {
    vi.useFakeTimers();
    try {
      const store = storeWith([{ hash: "v1", script: "512011", amountMsat: 50_000 }]);
      const funded: { script: string; vtxos: { txid: string; value: number }[] }[] = [];
      const { manager } = fakeManager(funded);

      const stop = startCovenantWatcher(store, manager, 1_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(store.get("v1")!.settled).toBe(false);

      funded.push({ script: "512011", vtxos: [{ txid: "tx-no-event", value: 50 }] });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(store.get("v1")).toMatchObject({ settled: true, paymentReference: "tx-no-event" });
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the periodic catch-up when stopped", async () => {
    vi.useFakeTimers();
    try {
      const store = storeWith([{ hash: "v1", script: "512011", amountMsat: 50_000 }]);
      const funded: { script: string; vtxos: { txid: string; value: number }[] }[] = [];
      const { manager } = fakeManager(funded);
      const getContracts = manager.getContractsWithVtxos as unknown as ReturnType<typeof vi.fn>;

      startCovenantWatcher(store, manager, 1_000)();
      await vi.advanceTimersByTimeAsync(0);
      const afterStop = getContracts.mock.calls.length;

      funded.push({ script: "512011", vtxos: [{ txid: "tx-after-stop", value: 50 }] });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(getContracts).toHaveBeenCalledTimes(afterStop);
      expect(store.get("v1")!.settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never runs two catch-up passes at once when one is slow", async () => {
    vi.useFakeTimers();
    try {
      const store = storeWith([{ hash: "v1", script: "512011", amountMsat: 50_000 }]);
      const { manager } = fakeManager();
      const getContracts = manager.getContractsWithVtxos as unknown as ReturnType<typeof vi.fn>;
      let release: (() => void) | undefined;
      getContracts.mockImplementationOnce(
        () => new Promise((resolve) => (release = () => resolve([]))),
      );

      const stop = startCovenantWatcher(store, manager, 1_000);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(getContracts).toHaveBeenCalledTimes(1);

      release!();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(getContracts).toHaveBeenCalledTimes(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the event's reference when a later catch-up sees the same payment", async () => {
    vi.useFakeTimers();
    try {
      const store = storeWith([{ hash: "v1", script: "512011", amountMsat: 50_000 }]);
      const { manager, received } = fakeManager([
        { script: "512011", vtxos: [{ txid: "tx-catchup", value: 50 }] },
      ]);

      const stop = startCovenantWatcher(store, manager, 1_000);
      received("512011", [{ txid: "tx-event", value: 50 }]);
      await vi.advanceTimersByTimeAsync(3_000);

      expect(store.get("v1")).toMatchObject({ settled: true, paymentReference: "tx-event" });
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a failed startup catch-up so downtime payments are not stranded", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = storeWith([{ hash: "v1", script: "512011", amountMsat: 50_000 }]);
      const { manager } = fakeManager([{ script: "512011", vtxos: [{ txid: "tx-while-down", value: 50 }] }]);
      const getContracts = manager.getContractsWithVtxos as unknown as ReturnType<typeof vi.fn>;
      getContracts.mockRejectedValueOnce(new Error("indexer unavailable"));

      const stop = startCovenantWatcher(store, manager, 1_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(store.get("v1")!.settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(store.get("v1")).toMatchObject({ settled: true, paymentReference: "tx-while-down" });
      expect(getContracts).toHaveBeenCalledTimes(2);
      stop();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("catchUp", () => {
  // A payment that lands while the process is down produces no event when it returns,
  // so without this the record would never settle.
  it("settles a destination funded before the subscription existed", async () => {
    const store = storeWith([{ hash: "v1", script: "512011", amountMsat: 50_000 }]);
    const { manager } = fakeManager([{ script: "512011", vtxos: [{ txid: "tx-while-down", value: 50 }] }]);

    expect(await catchUp(store, manager)).toBe(1);
    expect(store.get("v1")).toMatchObject({ settled: true, paymentReference: "tx-while-down" });
  });

  it("does not re-settle a record already observed", async () => {
    const store = storeWith([{ hash: "v1", script: "512011", amountMsat: 50_000 }]);
    store.markObserved("v1", "tx-original");
    const { manager } = fakeManager([{ script: "512011", vtxos: [{ txid: "tx-again", value: 50 }] }]);

    expect(await catchUp(store, manager)).toBe(0);
    expect(store.get("v1")!.paymentReference).toBe("tx-original");
  });
});

describe("catch-up cost", () => {
  // A pass used to call listPendingDestinations once per contract and scan it,
  // so cost was contracts x open payments. The attribution key is uniquely
  // indexed, so one lookup per contract is all it ever needed.
  it("looks each contract up by script instead of scanning the pending set", async () => {
    const records = Array.from({ length: 50 }, (_, i) => ({
      hash: `h${i}`,
      script: `5120${String(i).padStart(4, "0")}`,
      amountMsat: 1_000_000,
    }));
    const store = storeWith(records);
    let scans = 0;
    const original = store.listPendingDestinations.bind(store);
    store.listPendingDestinations = () => {
      scans++;
      return original();
    };

    const funded = records.map((r) => ({ script: r.script, vtxos: [{ txid: `tx-${r.hash}`, value: 1_000 }] }));
    const { manager } = fakeManager(funded);
    expect(await catchUp(store, manager)).toBe(50);
    expect(scans).toBe(0);
  });

  it("still settles only the record the script attributes the payment to", async () => {
    const store = storeWith([
      { hash: "a", script: "5120aa", amountMsat: 1_000_000 },
      { hash: "b", script: "5120bb", amountMsat: 1_000_000 },
    ]);
    const { manager } = fakeManager([{ script: "5120bb", vtxos: [{ txid: "tx-b", value: 1_000 }] }]);
    expect(await catchUp(store, manager)).toBe(1);
    expect(store.get("b")?.settled).toBe(true);
    expect(store.get("a")?.settled).toBe(false);
  });
});
