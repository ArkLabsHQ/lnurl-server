// Moves a per-payment covenant destination on to the user's static address.
//
// Nothing here is trusted with where the money goes: the emulator co-signs only a
// spend satisfying `enforcePayTo`, so the sweep can pay one place. That is also
// why the preimage is stored in the clear and why any party could run this — the
// user's own wallet can, through the two leaves keyed to them.
//
// What to spend and which leaf to spend it through both come from the contract
// manager. It reads every funded destination in one query and picks the path from
// the registered handler, so neither the outpoint set nor the leaf index is
// restated here.

import { base64, hex } from "@scure/base";
import { RawWitness } from "@scure/btc-signer";
import {
  ArkAddress,
  CSVMultisigTapscript,
  ConditionWitness,
  EmulatorPacket,
  Extension,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  Transaction,
  attachPrevArkTxs,
  buildOffchainTx,
  setArkPsbtField,
  type ArkProvider,
  type Contract,
  type IContractManager,
  type IndexerProvider,
  type PathSelection,
  type VirtualCoin,
} from "@arkade-os/sdk";
import { COVENANT_CONTRACT_TYPE, covenantDestinationHandler } from "./covenant-contract.js";
import { enforcePayTo } from "./covenant-destination.js";

interface EmulatorSubmit {
  submitTx(arkTx: string, checkpointTxs: string[]): Promise<{ signedArkTx: string; signedCheckpointTxs: string[] }>;
}

export interface CovenantSweeper {
  /** One pass over funded destinations. Returns how many moved. */
  sweep(): Promise<number>;
}

export function createCovenantSweeper(opts: {
  contracts: IContractManager;
  arkServerUrl: string;
  emulatorUrl: string;
  arkProvider?: ArkProvider;
  indexer?: IndexerProvider;
  emulator?: EmulatorSubmit;
}): CovenantSweeper {
  const arkProvider = opts.arkProvider ?? new RestArkProvider(opts.arkServerUrl);
  const indexer = opts.indexer ?? new RestIndexerProvider(opts.arkServerUrl);
  const emulator = opts.emulator ?? new RestEmulatorProvider(opts.emulatorUrl);

  const sweepOne = async (contract: Contract, vtxo: VirtualCoin, path: PathSelection): Promise<string> => {
    const { staticAddress } = covenantDestinationHandler.deserializeParams(contract.params);
    const payTo = ArkAddress.decode(staticAddress).pkScript;
    // Recomputed, not read off the leaf: the leaf holds the cosigner key, which is
    // a commitment to this script rather than the script itself.
    const packet = EmulatorPacket.create([{ vin: 0, script: enforcePayTo(payTo), witness: RawWitness.encode([]) }]);
    const info = await arkProvider.getInfo();
    const tapTree = covenantDestinationHandler.createScript(contract.params).encode();
    // The covenant reads the output at the spent input's index, so the payout stays 0.
    const { arkTx, checkpoints } = buildOffchainTx(
      [{ txid: vtxo.txid, vout: vtxo.vout, value: vtxo.value, tapLeafScript: path.leaf, tapTree }],
      [{ script: payTo, amount: BigInt(vtxo.value) }, Extension.create([packet]).txOut()],
      CSVMultisigTapscript.decode(hex.decode(info.checkpointTapscript)),
    );
    await attachPrevArkTxs(arkTx, [vtxo.txid], indexer);
    for (const witness of path.extraWitness ?? []) {
      setArkPsbtField(arkTx, 0, ConditionWitness, [witness]);
      setArkPsbtField(checkpoints[0]!, 0, ConditionWitness, [witness]);
    }

    const res = await emulator.submitTx(
      base64.encode(arkTx.toPSBT()),
      checkpoints.map((c) => base64.encode(c.toPSBT())),
    );
    return Transaction.fromPSBT(base64.decode(res.signedArkTx)).id;
  };

  return {
    async sweep() {
      let moved = 0;
      // One query for every funded destination, and the manager already knows which
      // outputs are still spendable — no per-record round trip, no vtxo bookkeeping.
      for (const { contract, vtxos } of await opts.contracts.getContractsWithVtxos({
        type: COVENANT_CONTRACT_TYPE,
      })) {
        for (const vtxo of vtxos) {
          if (vtxo.isSpent) continue;
          try {
            const [path] = await opts.contracts.getSpendablePaths({ contractScript: contract.script, vtxo });
            // No spendable path is not a failure: the recovery leaf is still timelocked
            // and the sweep leaf needs the emulator, which may simply be down.
            if (!path) continue;
            const arkTxid = await sweepOne(contract, vtxo, path);
            moved++;
            console.log(`covenant sweep: ${contract.script.slice(0, 16)}… -> ${arkTxid}`);
          } catch (err) {
            // One stuck destination must not stop the rest, and the next pass retries.
            console.warn(`covenant sweep failed for ${contract.script.slice(0, 16)}…:`, err);
          }
        }
      }
      return moved;
    },
  };
}

/** Run {@link CovenantSweeper.sweep} on an interval. Returns a stop function. */
export function startCovenantSweeper(sweeper: CovenantSweeper, intervalMs: number): () => void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void sweeper.sweep().finally(() => {
      inFlight = false;
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
