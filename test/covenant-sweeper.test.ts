import { describe, it, expect, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { CSVMultisigTapscript, MultisigTapscript, Transaction, VtxoScript, type IContractManager } from "@arkade-os/sdk";
import { createCovenantSweeper, startCovenantSweeper } from "../src/workers/covenant-sweeper.js";
import { MemorySettlementStore, type SettlementStore } from "../src/settlement-store.js";
import { COVENANT_CONTRACT_TYPE, covenantDestinationHandler as handler } from "../src/covenant/contract.js";
import { COLLABORATIVE_LEAF, COVENANT_V1, RECOVERY_LEAF, SWEEP_LEAF } from "../src/covenant/destination.js";

/** Real params, so the leaves the sweeper matches against are the real ones. */
const xonly = (fill: number) => secp256k1.getPublicKey(new Uint8Array(32).fill(fill), true).subarray(1);
const realParams = handler.serializeParams({
  staticAddress: new VtxoScript([MultisigTapscript.encode({ pubkeys: [xonly(9), xonly(3)] }).script])
    .address("tark", xonly(3))
    .encode(),
  userPubkey: xonly(4),
  serverPubkey: xonly(3),
  emulatorPubkey: secp256k1.getPublicKey(new Uint8Array(32).fill(5), true),
  preimage: new Uint8Array(32).fill(7),
  recoveryDelaySeconds: 4096,
  version: COVENANT_V1,
});
const realLeaves = handler.createScript(realParams).leaves;

// The funded path is proven against a live arkd + emulator (the e2e). What a fake can
// hold is which destinations are attempted at all, that a spent output is left alone,
// and that one broken destination cannot stop the others.

const contract = (script: string, watch: "awaiting-funds" | "retained" = "awaiting-funds") => ({
  type: COVENANT_CONTRACT_TYPE,
  // Real params: the sweeper rebuilds the script from these to find its leaf.
  params: realParams,
  script,
  address: `tark1for-${script}`,
  state: "active" as const,
  watch,
  createdAt: Date.now(),
});

const vtxo = (txid: string, opts: { spent?: boolean } = {}) => ({
  txid,
  vout: 0,
  value: 2000,
  isSpent: opts.spent ?? false,
});

function managerWith(
  entries: { script: string; vtxos: ReturnType<typeof vtxo>[] }[],
  watch: "awaiting-funds" | "retained" = "awaiting-funds",
) {
  const getSpendablePaths = vi.fn(async () => [{ leaf: {} as never, extraWitness: [] }]);
  const getContractsWithVtxos = vi.fn(async () =>
    entries.map((e) => ({ contract: contract(e.script, watch), vtxos: e.vtxos })),
  );
  return {
    manager: { getContractsWithVtxos, getSpendablePaths } as unknown as IContractManager,
    getContractsWithVtxos,
    getSpendablePaths,
  };
}

const CHECKPOINT_TAPSCRIPT = hex.encode(
  CSVMultisigTapscript.encode({ timelock: { type: "seconds", value: 1024n }, pubkeys: [xonly(3)] }).script,
);
const covenantPkScript = handler.createScript(realParams).pkScript;

/** Keyed by the txid it hashes to, so PrevArkTx resolution can find it. */
function fundingTx(valueSat: number, seed = 1) {
  const tx = new Transaction({ version: 3, allowUnknownOutputs: true });
  tx.addInput({ txid: new Uint8Array(32).fill(seed), index: 0 });
  tx.addOutput({ script: covenantPkScript, amount: BigInt(valueSat) });
  return { txid: tx.id, psbt: base64.encode(tx.toPSBT()) };
}

type Coin = ReturnType<typeof vtxo> & { arkTxId?: string };

/** Real signing, not an echo: these tests also pin that it leaves the txid alone. */
function signedReply(arkTx: string): string {
  const tx = Transaction.fromPSBT(base64.decode(arkTx));
  tx.signIdx(new Uint8Array(32).fill(3), 0, undefined, new Uint8Array(32).fill(0xab));
  return base64.encode(tx.toPSBT());
}

/** Builds the sweep for real, so the emulator's answer is something it can be wrong about. */
function realSweeper(opts: {
  funding: { psbt: string };
  vtxos: Coin[];
  settlements?: SettlementStore;
  reply?: (arkTx: string) => string;
}) {
  const contracts = {
    getContractsWithVtxos: async () => [{ contract: contract("5120aa"), vtxos: opts.vtxos }],
    getSpendablePaths: async () => [{ leaf: realLeaves[SWEEP_LEAF]!, extraWitness: [new Uint8Array(32).fill(7)] }],
  } as unknown as IContractManager;
  return createCovenantSweeper({
    contracts,
    arkServerUrl: "http://unused",
    emulatorUrl: "http://unused",
    arkProvider: { getInfo: async () => ({ checkpointTapscript: CHECKPOINT_TAPSCRIPT }) } as never,
    indexer: { getVirtualTxs: async () => ({ txs: [opts.funding.psbt] }) } as never,
    emulator: {
      submitTx: async (arkTx: string) => ({ signedArkTx: (opts.reply ?? signedReply)(arkTx), signedCheckpointTxs: [] }),
    },
    ...(opts.settlements ? { settlements: opts.settlements } : {}),
  });
}

function recorded(settlements: SettlementStore, amountMsat = 2_000_000) {
  settlements.create({
    paymentHash: "h", pr: "", sessionId: "s", paymentOption: "arkade",
    paymentDestination: "ark1x", amountMsat, covenantScript: "5120aa",
  });
}

const sweeperWith = (manager: IContractManager, settlements?: SettlementStore) =>
  createCovenantSweeper({
    contracts: manager,
    arkServerUrl: "http://unused",
    emulatorUrl: "http://unused",
    indexer: {} as never,
    arkProvider: { getInfo: async () => ({ checkpointTapscript: "00" }) } as never,
    emulator: { submitTx: async () => ({ signedArkTx: "", signedCheckpointTxs: [] }) },
    ...(settlements ? { settlements } : {}),
  });

describe("createCovenantSweeper", () => {
  it("asks the manager only for covenant destinations", async () => {
    const { manager, getContractsWithVtxos } = managerWith([]);

    await sweeperWith(manager).sweep();

    expect(getContractsWithVtxos).toHaveBeenCalledWith({ type: COVENANT_CONTRACT_TYPE });
  });

  // A pass force-syncs whatever it enumerates, so every dead destination in the
  // table used to cost an indexer round trip.
  it("asks only about the destinations still owed a sweep", async () => {
    const { manager, getContractsWithVtxos } = managerWith([{ script: "5120aa", vtxos: [vtxo("tx-a")] }]);
    const settlements = new MemorySettlementStore(3_600_000);
    settlements.create({ paymentHash: "live", pr: "", sessionId: "s", paymentOption: "arkade", paymentDestination: "ark1x", amountMsat: 1000, covenantScript: "5120aa" });
    settlements.create({ paymentHash: "done", pr: "", sessionId: "s", paymentOption: "arkade", paymentDestination: "ark1x", amountMsat: 1000, covenantScript: "5120bb" });
    settlements.markPaidOut("done", "sweep-tx");

    await sweeperWith(manager, settlements).sweep();

    expect(getContractsWithVtxos).toHaveBeenCalledWith({ script: ["5120aa"] });
  });

  it("skips a contract of another type at a scoped script", async () => {
    const getSpendablePaths = vi.fn(async (_q: { contractScript: string }) => [{ leaf: {} as never, extraWitness: [] }]);
    const getContractsWithVtxos = vi.fn(async () => [
      { contract: { ...contract("5120aa"), type: "swap-lockup", params: {} }, vtxos: [vtxo("tx-a")] },
      { contract: contract("5120bb"), vtxos: [vtxo("tx-b")] },
    ]);
    const settlements = new MemorySettlementStore(3_600_000);
    for (const script of ["5120aa", "5120bb"]) {
      settlements.create({ paymentHash: `h-${script}`, pr: "", sessionId: "s", paymentOption: "arkade", paymentDestination: "ark1x", amountMsat: 1000, covenantScript: script });
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await sweeperWith({ getContractsWithVtxos, getSpendablePaths } as unknown as IContractManager, settlements).sweep();
      expect(getSpendablePaths.mock.calls.map(([q]) => q.contractScript)).toEqual(["5120bb"]);
      expect(warn.mock.calls.flat().join(" ")).toContain("1 of 2");
    } finally {
      warn.mockRestore();
    }
  });

  it("queries nothing at all when no destination is owed a sweep", async () => {
    const { manager, getContractsWithVtxos } = managerWith([{ script: "5120aa", vtxos: [vtxo("tx-a")] }]);

    await sweeperWith(manager, new MemorySettlementStore(3_600_000)).sweep();

    expect(getContractsWithVtxos).not.toHaveBeenCalled();
  });

  it("warns once a pass when the manager resolves fewer contracts than it asked about", async () => {
    const { manager } = managerWith([{ script: "5120aa", vtxos: [] }, { script: "5120bb", vtxos: [] }]);
    const settlements = new MemorySettlementStore(3_600_000);
    for (const script of ["5120aa", "5120bb", "5120cc"]) {
      settlements.create({ paymentHash: `h-${script}`, pr: "", sessionId: "s", paymentOption: "arkade", paymentDestination: "ark1x", amountMsat: 1000, covenantScript: script });
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await sweeperWith(manager, settlements).sweep();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]!.join(" ")).toContain("2 of 3");
    } finally {
      warn.mockRestore();
    }
  });

  it("says nothing when every destination it asked about resolved, vtxos or not", async () => {
    const { manager } = managerWith([{ script: "5120aa", vtxos: [] }]);
    const settlements = new MemorySettlementStore(3_600_000);
    settlements.create({ paymentHash: "h", pr: "", sessionId: "s", paymentOption: "arkade", paymentDestination: "ark1x", amountMsat: 1000, covenantScript: "5120aa" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await sweeperWith(manager, settlements).sweep();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  // The SDK demotes a destination the instant a VTXO lands at it — which is exactly
  // when the money is there and the sweep has not run. Scoping on watch state would
  // strand it; scoping on our own records does not.
  it("still sweeps a funded destination the SDK has already demoted", async () => {
    const { manager, getSpendablePaths } = managerWith([{ script: "5120aa", vtxos: [vtxo("tx-a")] }], "retained");
    const settlements = new MemorySettlementStore(3_600_000);
    settlements.create({ paymentHash: "live", pr: "", sessionId: "s", paymentOption: "arkade", paymentDestination: "ark1x", amountMsat: 1000, covenantScript: "5120aa" });
    settlements.markObserved("live", "tx-a");

    await sweeperWith(manager, settlements).sweep();

    expect(getSpendablePaths).toHaveBeenCalled();
  });

  // One query for every destination, where the old shape issued one per record.
  it("reads every funded destination in a single query", async () => {
    const { manager, getContractsWithVtxos } = managerWith([
      { script: "5120aa", vtxos: [vtxo("tx-a")] },
      { script: "5120bb", vtxos: [vtxo("tx-b")] },
      { script: "5120cc", vtxos: [vtxo("tx-c")] },
    ]);

    await sweeperWith(manager).sweep();

    expect(getContractsWithVtxos).toHaveBeenCalledTimes(1);
  });

  it("leaves a spent output alone", async () => {
    const { manager, getSpendablePaths } = managerWith([
      { script: "5120aa", vtxos: [vtxo("tx-spent", { spent: true })] },
    ]);

    await sweeperWith(manager).sweep();

    expect(getSpendablePaths).not.toHaveBeenCalled();
  });

  // A split payment left two outpoints at one script; both are the user's.
  it("attempts each unspent outpoint at a destination", async () => {
    const { manager, getSpendablePaths } = managerWith([
      { script: "5120aa", vtxos: [vtxo("tx-1"), vtxo("tx-2")] },
    ]);

    await sweeperWith(manager).sweep();

    expect(getSpendablePaths).toHaveBeenCalledTimes(2);
  });

  // Timelocked recovery and a down emulator both look like this, and neither is
  // an error worth logging every pass.
  it("skips a destination with no spendable path", async () => {
    const { manager, getSpendablePaths } = managerWith([{ script: "5120aa", vtxos: [vtxo("tx-a")] }]);
    getSpendablePaths.mockResolvedValue([]);

    await expect(sweeperWith(manager).sweep()).resolves.toBe(0);
  });

  // Finding 7: taking paths[0] made this depend on the handler's push order. The
  // manager promises no ordering, and the wrong leaf builds a witness-less tx the
  // emulator refuses — a silent skip every pass rather than a readable error.
  it("picks the sweep leaf whatever order the manager returns paths in", async () => {
    const getInfo = vi.fn(async () => ({ checkpointTapscript: "00" }));
    const contracts = {
      getContractsWithVtxos: async () => [
        { contract: { type: COVENANT_CONTRACT_TYPE, script: "5120aa", params: realParams }, vtxos: [vtxo("tx-a")] },
      ],
      // Reversed: recovery, collaborative, sweep.
      getSpendablePaths: async () => [
        { leaf: realLeaves[RECOVERY_LEAF]! },
        { leaf: realLeaves[COLLABORATIVE_LEAF]! },
        { leaf: realLeaves[SWEEP_LEAF]!, extraWitness: [new Uint8Array(32).fill(7)] },
      ],
    } as unknown as IContractManager;

    await createCovenantSweeper({
      contracts,
      arkServerUrl: "http://unused",
      emulatorUrl: "http://unused",
      indexer: {} as never,
      arkProvider: { getInfo } as never,
      emulator: { submitTx: async () => ({ signedArkTx: "", signedCheckpointTxs: [] }) },
    }).sweep();

    // Reaching getInfo means a path was chosen; the sweep leaf is the only one here
    // this service could complete, and it was last in the array.
    expect(getInfo).toHaveBeenCalled();
  });

  it("skips when the manager offers no leaf this service can complete", async () => {
    const getInfo = vi.fn(async () => ({ checkpointTapscript: "00" }));
    const contracts = {
      getContractsWithVtxos: async () => [
        { contract: { type: COVENANT_CONTRACT_TYPE, script: "5120aa", params: realParams }, vtxos: [vtxo("tx-a")] },
      ],
      // The user's own two leaves, never ours to spend. Position-based selection
      // would have taken the first of these and built an unsignable transaction.
      getSpendablePaths: async () => [
        { leaf: realLeaves[COLLABORATIVE_LEAF]! },
        { leaf: realLeaves[RECOVERY_LEAF]! },
      ],
    } as unknown as IContractManager;

    const moved = await createCovenantSweeper({
      contracts,
      arkServerUrl: "http://unused",
      emulatorUrl: "http://unused",
      indexer: {} as never,
      arkProvider: { getInfo } as never,
      emulator: { submitTx: async () => ({ signedArkTx: "", signedCheckpointTxs: [] }) },
    }).sweep();

    expect(moved).toBe(0);
    expect(getInfo).not.toHaveBeenCalled();
  });

  it("sweeps on a trigger rather than waiting out the catch-up", async () => {
    let passes = 0;
    // An interval long enough that a tick cannot be what satisfies this.
    const handle = startCovenantSweeper({ sweep: async () => { passes++; return 0; } }, 600_000);
    try {
      await vi.waitFor(() => expect(passes).toBe(0));
      handle.trigger();
      await vi.waitFor(() => expect(passes).toBe(1));
      handle.trigger();
      await vi.waitFor(() => expect(passes).toBe(2));
    } finally {
      handle.stop();
    }
  });

  it("survives a sweep that rejects, and sweeps again on the next trigger", async () => {
    let passes = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handle = startCovenantSweeper({ sweep: async () => { passes++; throw new Error("contract manager unavailable"); } }, 600_000);
    try {
      handle.trigger();
      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
      handle.trigger();
      await vi.waitFor(() => expect(passes).toBe(2));
    } finally {
      handle.stop();
      warn.mockRestore();
    }
  });

  it("runs no further passes once stopped", async () => {
    let passes = 0;
    const handle = startCovenantSweeper({ sweep: async () => { passes++; return 0; } }, 600_000);
    handle.stop();
    handle.trigger();
    await new Promise((r) => setTimeout(r, 50));
    expect(passes).toBe(0);
  });

  it("counts a sweep the emulator answered with a different transaction as failed", async () => {
    const funding = fundingTx(2000);
    const other = fundingTx(2000, 2);
    const settlements = new MemorySettlementStore(3_600_000);
    recorded(settlements);
    settlements.markObserved("h", funding.txid);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const moved = await realSweeper({ funding, vtxos: [vtxo(funding.txid)], settlements, reply: () => other.psbt }).sweep();

      expect(moved).toBe(0);
      expect(settlements.get("h")!.payoutReference).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("records the payout from the spend of the output that settled the record", async () => {
    const funding = fundingTx(2000);
    const settlements = new MemorySettlementStore(3_600_000);
    recorded(settlements);
    settlements.markObserved("h", funding.txid);
    const swept: Coin = { ...vtxo(funding.txid, { spent: true }), arkTxId: "sweep-tx" };

    await realSweeper({ funding, vtxos: [swept], settlements }).sweep();

    expect(settlements.get("h")!.payoutReference).toBe("sweep-tx");
  });

  // Moving a sub-amount payment to the user's own address is right; the real payment may still follow.
  it("records no payout for a sweep of an unsettled destination, and keeps it in scope", async () => {
    const funding = fundingTx(1000);
    const settlements = new MemorySettlementStore(3_600_000);
    recorded(settlements);

    const moved = await realSweeper({ funding, vtxos: [{ ...vtxo(funding.txid), value: 1000 }], settlements }).sweep();

    expect(moved).toBe(1);
    expect(settlements.get("h")!.payoutReference).toBeNull();
    expect(settlements.listActiveCovenantScripts()).toContain("5120aa");
  });

  // One pass behind is the accepted cost of not trusting the emulator's answer.
  it("records the payout on the pass after the one that swept", async () => {
    const funding = fundingTx(2000);
    const settlements = new MemorySettlementStore(3_600_000);
    recorded(settlements);
    const coin: Coin = vtxo(funding.txid);
    const sweeper = realSweeper({ funding, vtxos: [coin], settlements });

    expect(await sweeper.sweep()).toBe(1);
    expect(settlements.get("h")!.payoutReference).toBeNull();

    settlements.markObserved("h", funding.txid);
    coin.isSpent = true;
    coin.arkTxId = "sweep-tx";

    expect(await sweeper.sweep()).toBe(0);
    expect(settlements.get("h")!.payoutReference).toBe("sweep-tx");
  });

  it("keeps going after one destination throws", async () => {
    const { manager, getSpendablePaths } = managerWith([
      { script: "5120aa", vtxos: [vtxo("tx-a")] },
      { script: "5120bb", vtxos: [vtxo("tx-b")] },
    ]);
    getSpendablePaths.mockRejectedValueOnce(new Error("indexer down"));

    await sweeperWith(manager).sweep();

    expect(getSpendablePaths).toHaveBeenCalledTimes(2);
  });
});
