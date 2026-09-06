// Moves a per-payment covenant destination on to the user's static address.
//
// Nothing here is trusted with where the money goes: the emulator co-signs only a
// spend satisfying `enforcePayTo`, so the sweep can pay one place. That is also
// why the preimage is stored in the clear and why any party could run this — the
// user's own wallet can, through the two leaves keyed to them.

import { base64, hex } from "@scure/base";
import { RawWitness } from "@scure/btc-signer";
import {
  CSVMultisigTapscript,
  ConditionWitness,
  EmulatorPacket,
  Extension,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  Transaction,
  VtxoScript,
  attachPrevArkTxs,
  buildOffchainTx,
  setArkPsbtField,
  type ArkProvider,
  type IndexerProvider,
} from "@arkade-os/sdk";
import type { SettlementStore } from "./settlement-store.js";
import { enforcePayTo } from "./covenant-destination.js";

export type SweepOutcome =
  | { state: "swept"; arkTxid: string }
  | { state: "skipped"; reason: "unfunded" | "incomplete" };

interface EmulatorSubmit {
  submitTx(arkTx: string, checkpointTxs: string[]): Promise<{ signedArkTx: string; signedCheckpointTxs: string[] }>;
}

export interface CovenantSweeper {
  /** One pass over funded destinations. Returns how many moved. */
  sweep(): Promise<number>;
}

export function createCovenantSweeper(opts: {
  store: SettlementStore;
  arkServerUrl: string;
  emulatorUrl: string;
  arkProvider?: ArkProvider;
  indexer?: IndexerProvider;
  emulator?: EmulatorSubmit;
}): CovenantSweeper {
  const arkProvider = opts.arkProvider ?? new RestArkProvider(opts.arkServerUrl);
  const indexer = opts.indexer ?? new RestIndexerProvider(opts.arkServerUrl);
  const emulator = opts.emulator ?? new RestEmulatorProvider(opts.emulatorUrl);

  const sweepOne = async (
    rec: { covenantScript: string; covenantPreimage: string; covenantTapTree: string; covenantPayoutScript: string },
  ): Promise<SweepOutcome> => {
    const { vtxos } = await indexer.getVtxos({ scripts: [rec.covenantScript], spendableOnly: true });
    // Not funded yet and already swept are the same no-op, so retries are safe.
    if (vtxos.length !== 1) return { state: "skipped", reason: "unfunded" };
    const utxo = vtxos[0]!;

    const tapTree = hex.decode(rec.covenantTapTree);
    const vtxo = VtxoScript.decode(tapTree);
    const payTo = hex.decode(rec.covenantPayoutScript);
    // Recomputed, not read off the leaf: the leaf holds the cosigner key, which is
    // a commitment to this script rather than the script itself.
    const covenantScript = enforcePayTo(payTo);
    const packet = EmulatorPacket.create([{ vin: 0, script: covenantScript, witness: RawWitness.encode([]) }]);
    const info = await arkProvider.getInfo();
    // The covenant reads the output at the spent input's index, so the payout stays 0.
    const { arkTx, checkpoints } = buildOffchainTx(
      [{ txid: utxo.txid, vout: utxo.vout, value: utxo.value, tapLeafScript: vtxo.leaves[0]!, tapTree }],
      [{ script: payTo, amount: BigInt(utxo.value) }, Extension.create([packet]).txOut()],
      CSVMultisigTapscript.decode(hex.decode(info.checkpointTapscript)),
    );
    await attachPrevArkTxs(arkTx, [utxo.txid], indexer);
    const preimage = hex.decode(rec.covenantPreimage);
    setArkPsbtField(arkTx, 0, ConditionWitness, [preimage]);
    setArkPsbtField(checkpoints[0]!, 0, ConditionWitness, [preimage]);

    const res = await emulator.submitTx(
      base64.encode(arkTx.toPSBT()),
      checkpoints.map((c) => base64.encode(c.toPSBT())),
    );
    return { state: "swept", arkTxid: Transaction.fromPSBT(base64.decode(res.signedArkTx)).id };
  };

  return {
    async sweep() {
      let moved = 0;
      for (const rec of opts.store.listPendingDestinations()) {
        const { covenantScript, covenantPreimage, covenantTapTree, covenantPayoutScript } = rec;
        if (!covenantScript || !covenantPreimage || !covenantTapTree || !covenantPayoutScript) continue;
        try {
          const outcome = await sweepOne({ covenantScript, covenantPreimage, covenantTapTree, covenantPayoutScript });
          if (outcome.state === "swept") {
            moved++;
            console.log(`covenant sweep: ${rec.paymentHash} -> ${outcome.arkTxid}`);
          }
        } catch (err) {
          // One stuck destination must not stop the rest, and the next pass retries.
          console.warn(`covenant sweep failed for ${rec.paymentHash}:`, err);
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
