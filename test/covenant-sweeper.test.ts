import { describe, it, expect, vi } from "vitest";
import { createCovenantSweeper } from "../src/covenant-sweeper.js";
import { MemorySettlementStore } from "../src/settlement-store.js";
import type { IndexerProvider } from "@arkade-os/sdk";

// The funded path is proven against a live arkd + emulator rather than faked
// (see the PR): what a fake can hold is which records are attempted at all, and
// that one broken destination cannot stop the others.

const record = (hash: string, script: string, complete = true) => ({
  paymentHash: hash,
  pr: "",
  sessionId: "s",
  paymentOption: "arkade",
  paymentDestination: `tark1for-${hash}`,
  amountMsat: 2_000_000,
  ...(complete
    ? {
        covenantScript: script,
        covenantPreimage: "aa".repeat(32),
        covenantTapTree: "bb",
        covenantPayoutScript: "5120" + "cc".repeat(32),
      }
    : {}),
});

const indexerReturning = (byScript: Record<string, number>) =>
  ({
    getVtxos: vi.fn(async ({ scripts }: { scripts: string[] }) => {
      const script = scripts[0]!;
      const value = byScript[script];
      return {
        vtxos: value === undefined ? [] : [{ txid: `tx-${script}`, vout: 0, value, script }],
      };
    }),
  }) as unknown as IndexerProvider;

const sweeperWith = (store: MemorySettlementStore, indexer: IndexerProvider) =>
  createCovenantSweeper({
    store,
    arkServerUrl: "http://unused",
    emulatorUrl: "http://unused",
    indexer,
    arkProvider: { getInfo: async () => ({ checkpointTapscript: "00" }) } as never,
    emulator: { submitTx: async () => ({ signedArkTx: "", signedCheckpointTxs: [] }) },
  });

describe("createCovenantSweeper", () => {
  it("ignores a destination record carrying no covenant, leaving the static path alone", async () => {
    const store = new MemorySettlementStore(3_600_000);
    store.create(record("static-only", "", false));
    const indexer = indexerReturning({});

    expect(await sweeperWith(store, indexer).sweep()).toBe(0);
    expect(indexer.getVtxos).not.toHaveBeenCalled();
  });

  it("skips an unfunded destination without submitting anything", async () => {
    const store = new MemorySettlementStore(3_600_000);
    store.create(record("v1", "5120aa"));
    const submitTx = vi.fn();
    const sweeper = createCovenantSweeper({
      store,
      arkServerUrl: "http://unused",
      emulatorUrl: "http://unused",
      indexer: indexerReturning({}),
      arkProvider: { getInfo: async () => ({ checkpointTapscript: "00" }) } as never,
      emulator: { submitTx },
    });

    expect(await sweeper.sweep()).toBe(0);
    expect(submitTx).not.toHaveBeenCalled();
  });

  it("still sweeps a record the watcher has already settled", async () => {
    const store = new MemorySettlementStore(3_600_000);
    store.create(record("v1", "5120aa"));
    expect(store.markObserved("v1", "tx-observed")).toBe(true);
    expect(store.listPendingDestinations()).toHaveLength(0);
    const indexer = indexerReturning({ "5120aa": 2000 });

    await sweeperWith(store, indexer).sweep();

    expect(indexer.getVtxos).toHaveBeenCalledWith(expect.objectContaining({ scripts: ["5120aa"] }));
  });

  it("keeps sweeping after one destination throws", async () => {
    const store = new MemorySettlementStore(3_600_000);
    store.create(record("bad", "5120bad"));
    store.create(record("good", "5120good"));
    const indexer = {
      getVtxos: vi.fn(async ({ scripts }: { scripts: string[] }) => {
        if (scripts[0] === "5120bad") throw new Error("indexer exploded");
        return { vtxos: [{ txid: "tx-good", vout: 0, value: 2000, script: "5120good" }] };
      }),
    } as unknown as IndexerProvider;

    // Both are attempted: a throw on one is caught per-record, not per-pass. The
    // fake cannot finish a real spend, so what is pinned is reaching the second.
    await sweeperWith(store, indexer).sweep();
    expect(indexer.getVtxos).toHaveBeenCalledTimes(2);
  });
});
