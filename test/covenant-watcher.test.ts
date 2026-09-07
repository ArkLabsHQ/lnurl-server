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
      covenantPreimage: "aa".repeat(32),
      covenantTapTree: "bb",
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
