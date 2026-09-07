import { describe, it, expect, vi } from "vitest";
import type { IContractManager } from "@arkade-os/sdk";
import { createCovenantSweeper } from "../src/covenant-sweeper.js";
import { COVENANT_CONTRACT_TYPE } from "../src/covenant-contract.js";

// The funded path is proven against a live arkd + emulator (the e2e). What a fake can
// hold is which destinations are attempted at all, that a spent output is left alone,
// and that one broken destination cannot stop the others.

const contract = (script: string) => ({
  type: COVENANT_CONTRACT_TYPE,
  params: {},
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
