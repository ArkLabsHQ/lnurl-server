import { describe, it, expect, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { MultisigTapscript, VtxoScript, type IContractManager } from "@arkade-os/sdk";
import { createCovenantSweeper } from "../src/covenant-sweeper.js";
import { COVENANT_CONTRACT_TYPE, covenantDestinationHandler as handler } from "../src/covenant-contract.js";
import { COLLABORATIVE_LEAF, RECOVERY_LEAF, SWEEP_LEAF } from "../src/covenant-destination.js";

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
});
const realLeaves = handler.createScript(realParams).leaves;

// The funded path is proven against a live arkd + emulator (the e2e). What a fake can
// hold is which destinations are attempted at all, that a spent output is left alone,
// and that one broken destination cannot stop the others.

const contract = (script: string) => ({
  type: COVENANT_CONTRACT_TYPE,
  // Real params: the sweeper rebuilds the script from these to find its leaf.
  params: realParams,
  script,
  address: `tark1for-${script}`,
  state: "active" as const,
  createdAt: Date.now(),
});

const vtxo = (txid: string, opts: { spent?: boolean } = {}) => ({
  txid,
  vout: 0,
  value: 2000,
  isSpent: opts.spent ?? false,
});

function managerWith(entries: { script: string; vtxos: ReturnType<typeof vtxo>[] }[]) {
  const getSpendablePaths = vi.fn(async () => [{ leaf: {} as never, extraWitness: [] }]);
  const getContractsWithVtxos = vi.fn(async () =>
    entries.map((e) => ({ contract: contract(e.script), vtxos: e.vtxos })),
  );
  return {
    manager: { getContractsWithVtxos, getSpendablePaths } as unknown as IContractManager,
    getContractsWithVtxos,
    getSpendablePaths,
  };
}

const sweeperWith = (manager: IContractManager) =>
  createCovenantSweeper({
    contracts: manager,
    arkServerUrl: "http://unused",
    emulatorUrl: "http://unused",
    indexer: {} as never,
    arkProvider: { getInfo: async () => ({ checkpointTapscript: "00" }) } as never,
    emulator: { submitTx: async () => ({ signedArkTx: "", signedCheckpointTxs: [] }) },
  });

describe("createCovenantSweeper", () => {
  it("asks the manager only for covenant destinations", async () => {
    const { manager, getContractsWithVtxos } = managerWith([]);

    await sweeperWith(manager).sweep();

    expect(getContractsWithVtxos).toHaveBeenCalledWith({ type: COVENANT_CONTRACT_TYPE });
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
