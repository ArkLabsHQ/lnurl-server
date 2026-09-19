// Moves a per-payment covenant destination on to the user's static address.
//
// Nothing here is trusted with where the money goes: the emulator co-signs only a
// spend satisfying `enforcePayTo`, so the sweep can pay one place. That is also
// why the preimage is stored in the clear and why any party could run this — the
// user's own wallet can, through the two leaves keyed to them.
//
// What to spend comes from the contract manager, which reads every funded
// destination in one query. How to spend it comes from src/self-claim.ts: the
// covenant here and the one on a solver's lockup are the same VHTLC leaf, so the
// two rails share a builder rather than each assembling the transaction.

import {
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  type ArkProvider,
  type IContractManager,
  type IndexerProvider,
} from "@arkade-os/sdk";
import { COVENANT_CONTRACT_TYPE, covenantDestinationHandler } from "./covenant-contract.js";
import { pushNonInteractiveClaim } from "./self-claim.js";

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

  return {
    async sweep() {
      let moved = 0;
      // One query for every funded destination, and the manager already knows which
      // outputs are still spendable — no per-record round trip, no vtxo bookkeeping.
      for (const { contract, vtxos } of await opts.contracts.getContractsWithVtxos({
        type: COVENANT_CONTRACT_TYPE,
      })) {
        const live = vtxos.filter((v) => !v.isSpent);
        if (live.length === 0) continue;
        // Rides alongside the VHTLC's own serialized parameters, which carry the
        // preimage HASH and not the preimage. Under its own key, not `preimage`,
        // which the SDK reads to gate a different leaf. @see covenant-destination.ts
        const preimage = contract.params.covenantPreimage;
        if (!preimage) {
          console.warn(`covenant sweep: ${contract.script.slice(0, 16)}… has no stored preimage`);
          continue;
        }
        try {
          // Every live output in one transaction, as the lockup path does: the
          // covenant checks each spent input against the output at its own index,
          // so a destination funded twice sweeps once rather than not at all.
          const arkTxid = await pushNonInteractiveClaim({
            script: covenantDestinationHandler.createScript(contract.params),
            vtxos: live,
            preimage,
            arkProvider,
            indexer,
            emulator,
          });
          // VTXOs, not transactions: one aggregated claim can move several, so
          // this counts what was swept rather than how many pushes it took.
          moved += live.length;
          console.log(`covenant sweep: ${contract.script.slice(0, 16)}… -> ${arkTxid}`);
        } catch (err) {
          // One stuck destination must not stop the rest, and the next pass retries.
          console.warn(`covenant sweep failed for ${contract.script.slice(0, 16)}…:`, err);
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
