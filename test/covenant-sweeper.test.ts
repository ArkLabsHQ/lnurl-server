import { describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { base64, hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { CSVMultisigTapscript, MultisigTapscript, VtxoScript, type IContractManager } from "@arkade-os/sdk";
import { createCovenantSweeper } from "../src/covenant-sweeper.js";
import { COVENANT_CONTRACT_TYPE, covenantDestinationHandler as handler } from "../src/covenant-contract.js";
import { covenantVtxoScript } from "../src/covenant-destination.js";

/** Real params, so the script the sweeper rebuilds is the real one. */
const xonly = (fill: number) => secp256k1.getPublicKey(new Uint8Array(32).fill(fill), true).subarray(1);
const PREIMAGE = new Uint8Array(32).fill(7);
/** Decodable, because the sweeper now builds the real transaction rather than
 *  stopping at a faked spending path. */
const CHECKPOINT_TAPSCRIPT = hex.encode(
  CSVMultisigTapscript.encode({ timelock: { type: "seconds", value: 1024n }, pubkeys: [xonly(3)] }).script,
);
const covenant = covenantVtxoScript({
      staticAddress: new VtxoScript([MultisigTapscript.encode({ pubkeys: [xonly(9), xonly(3)] }).script])
        .address("tark", xonly(3))
        .encode(),
      userPubkey: xonly(4),
      serverPubkey: xonly(3),
      emulatorPubkey: secp256k1.getPublicKey(new Uint8Array(32).fill(5), true),
  preimage: PREIMAGE,
  recoveryDelaySeconds: 4096,
  refundLocktime: 1_800_000_000,
});
const realParams = {
  ...handler.serializeParams(covenant.vtxo.options),
  covenantPreimage: hex.encode(PREIMAGE),
};

/** Keyed by the txid it actually hashes to, so PrevArkTx resolution can find it. */
const virtualTxs = new Map<string, string>();
function fundedVtxo(valueSat = 2_000, opts: { spent?: boolean } = {}) {
  const tx = new Transaction({ version: 3, allowUnknownOutputs: true });
  tx.addInput({ txid: randomBytes(32), index: 0 });
  tx.addOutput({ script: covenant.vtxo.pkScript, amount: BigInt(valueSat) });
  virtualTxs.set(tx.id, base64.encode(tx.toPSBT()));
  return { txid: tx.id, vout: 0, value: valueSat, isSpent: opts.spent ?? false };
}

const fakeIndexer = {
  getVirtualTxs: async (txids: string[]) => ({
    txs: txids.map((id) => virtualTxs.get(id)).filter(Boolean) as string[],
  }),
} as never;

// The funded path is proven against a live arkd + emulator (the e2e). What a fake can
// hold is which destinations are attempted at all, that a spent output is left alone,
// that every live output goes into one claim, and that one broken destination cannot
// stop the others.

const contract = (script: string, params: Record<string, string> = realParams) => ({
  type: COVENANT_CONTRACT_TYPE,
  params,
  script,
  address: `tark1for-${script}`,
  state: "active" as const,
  createdAt: Date.now(),
});

function managerWith(entries: { script: string; vtxos: ReturnType<typeof fundedVtxo>[]; params?: Record<string, string> }[]) {
  const getContractsWithVtxos = vi.fn(async () =>
    entries.map((e) => ({ contract: contract(e.script, e.params), vtxos: e.vtxos })),
  );
  return {
    manager: { getContractsWithVtxos } as unknown as IContractManager,
    getContractsWithVtxos,
  };
}

/** Captures what reached the emulator, which is the only side effect worth asserting. */
function sweeperWith(manager: IContractManager) {
  const submitted: { arkTx: string }[] = [];
  const sweeper = createCovenantSweeper({
    contracts: manager,
    arkServerUrl: "http://unused",
    emulatorUrl: "http://unused",
    indexer: fakeIndexer,
    arkProvider: { getInfo: async () => ({ checkpointTapscript: CHECKPOINT_TAPSCRIPT }) } as never,
    emulator: {
      submitTx: async (arkTx: string) => {
        submitted.push({ arkTx });
        return { signedArkTx: "", signedCheckpointTxs: [] };
      },
    },
  });
  return { sweeper, submitted };
}

describe("createCovenantSweeper", () => {
  it("asks the manager only for covenant destinations", async () => {
    const { manager, getContractsWithVtxos } = managerWith([]);
    await sweeperWith(manager).sweeper.sweep();
    expect(getContractsWithVtxos).toHaveBeenCalledWith({ type: COVENANT_CONTRACT_TYPE });
  });

  it("reads every funded destination in a single query", async () => {
    const { manager, getContractsWithVtxos } = managerWith([
      { script: "5120aa", vtxos: [fundedVtxo()] },
      { script: "5120bb", vtxos: [fundedVtxo()] },
    ]);
    await sweeperWith(manager).sweeper.sweep();
    expect(getContractsWithVtxos).toHaveBeenCalledTimes(1);
  });

  it("leaves a destination whose only output is already spent alone", async () => {
    const { manager } = managerWith([{ script: "5120aa", vtxos: [fundedVtxo(2_000, { spent: true })] }]);
    const { sweeper, submitted } = sweeperWith(manager);
    expect(await sweeper.sweep()).toBe(0);
    expect(submitted).toHaveLength(0);
  });

  // The covenant checks each spent input against the output at its own index, so a
  // destination funded twice is one claim over both — not two claims, and not a
  // single output swept while the other is stranded.
  it("puts every live output of one destination into a single claim", async () => {
    const { manager } = managerWith([
      { script: "5120aa", vtxos: [fundedVtxo(), fundedVtxo(), fundedVtxo(2_000, { spent: true })] },
    ]);
    const { sweeper, submitted } = sweeperWith(manager);
    expect(await sweeper.sweep()).toBe(2);
    expect(submitted).toHaveLength(1);
  });

  it("skips a destination whose contract carries no preimage", async () => {
    const { covenantPreimage: _dropped, ...withoutPreimage } = realParams;
    const { manager } = managerWith([{ script: "5120aa", vtxos: [fundedVtxo()], params: withoutPreimage }]);
    const { sweeper, submitted } = sweeperWith(manager);
    expect(await sweeper.sweep()).toBe(0);
    expect(submitted).toHaveLength(0);
  });

  it("keeps going after one destination throws", async () => {
    const { manager } = managerWith([
      { script: "5120aa", vtxos: [fundedVtxo()] },
      { script: "5120bb", vtxos: [fundedVtxo()] },
    ]);
    let calls = 0;
    const sweeper = createCovenantSweeper({
      contracts: manager,
      arkServerUrl: "http://unused",
      emulatorUrl: "http://unused",
      indexer: fakeIndexer,
      arkProvider: { getInfo: async () => ({ checkpointTapscript: CHECKPOINT_TAPSCRIPT }) } as never,
      emulator: {
        submitTx: async () => {
          if (++calls === 1) throw new Error("emulator down");
          return { signedArkTx: "", signedCheckpointTxs: [] };
        },
      },
    });
    expect(await sweeper.sweep()).toBe(1);
    expect(calls).toBe(2);
  });
});
