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
  createAssetPacket,
  setArkPsbtField,
  type ArkProvider,
  type Contract,
  type IContractManager,
  type IndexerProvider,
  type PathSelection,
  type VirtualCoin,
} from "@arkade-os/sdk";
import { COVENANT_CONTRACT_TYPE, covenantDestinationHandler } from "./covenant-contract.js";
import type { SettlementStore } from "./settlement-store.js";
import { COVENANT_V1, COVENANT_V2, SWEEP_LEAF, enforcePayTo, enforcePayToWithAssets } from "./covenant-destination.js";

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
  /** Optional: records which transaction credited the user. Sweeping works without it. */
  settlements?: SettlementStore;
}): CovenantSweeper {
  const arkProvider = opts.arkProvider ?? new RestArkProvider(opts.arkServerUrl);
  const indexer = opts.indexer ?? new RestIndexerProvider(opts.arkServerUrl);
  const emulator = opts.emulator ?? new RestEmulatorProvider(opts.emulatorUrl);

  const sweepOne = async (
    contract: Contract,
    vtxo: VirtualCoin,
    path: PathSelection,
    tapTree: Uint8Array,
  ): Promise<string> => {
    const params = covenantDestinationHandler.deserializeParams(contract.params);
    const { staticAddress } = params;
    const payTo = ArkAddress.decode(staticAddress).pkScript;
    // Recomputed, not read off the leaf, and versioned from the contract's own
    // params: v2 bytes do not reproduce a v1 cosigner, so the emulator would refuse.
    const covenant = (params.version ?? COVENANT_V1) >= COVENANT_V2
      ? enforcePayToWithAssets(payTo)
      : enforcePayTo(payTo);
    const packet = EmulatorPacket.create([{ vin: 0, script: covenant, witness: RawWitness.encode([]) }]);
    // arkd rejects a spend of asset-carrying inputs declaring no packet, so without
    // this the destination could never be swept. Under v2 the covenant requires it too.
    const assets = vtxo.assets ?? [];
    const packets = assets.length > 0
      ? [createAssetPacket(new Map([[0, assets]]), [{ address: staticAddress, amount: vtxo.value, assets }]), packet]
      : [packet];
    const info = await arkProvider.getInfo();
    // The covenant reads the output at the spent input's index, so the payout stays 0.
    const { arkTx, checkpoints } = buildOffchainTx(
      [{ txid: vtxo.txid, vout: vtxo.vout, value: vtxo.value, tapLeafScript: path.leaf, tapTree }],
      [{ script: payTo, amount: BigInt(vtxo.value) }, Extension.create(packets).txOut()],
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
        const script = covenantDestinationHandler.createScript(contract.params);
        const tapTree = script.encode();
        const sweepLeaf = hex.encode(script.leaves[SWEEP_LEAF]![1]);
        for (const vtxo of vtxos) {
          if (vtxo.isSpent) continue;
          try {
            const paths = await opts.contracts.getSpendablePaths({ contractScript: contract.script, vtxo });
            // Chosen by leaf, not by position. The handler happens to return the sweep
            // first, but nothing in the manager's contract promises an order, and the
            // wrong leaf builds a transaction with no preimage that the emulator simply
            // refuses — a silent skip every pass rather than an error worth reading.
            const path = paths.find((p) => hex.encode(p.leaf[1]) === sweepLeaf);
            // No sweepable path is not a failure: the emulator may be down, and the
            // user's own two leaves are never ours to spend.
            if (!path) continue;
            const arkTxid = await sweepOne(contract, vtxo, path, tapTree);
            moved++;
            // What the user's wallet holds: the payment landed at the covenant.
            const record = opts.settlements?.findByCovenantScript(contract.script);
            if (record) opts.settlements?.markPaidOut(record.paymentHash, arkTxid);
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

export interface CovenantSweeperHandle {
  /** Sweep now — for a destination the watcher just saw funded. */
  trigger(): void;
  stop(): void;
}

/**
 * Run {@link CovenantSweeper.sweep} on demand, with a catch-up behind it.
 *
 * The sweep is what the recipient can spend, so a tick spent the whole interval with
 * their money at an address only this server can move it from. covenant-watcher.ts
 * already learns the moment one is funded.
 */
export function startCovenantSweeper(sweeper: CovenantSweeper, catchUpIntervalMs: number): CovenantSweeperHandle {
  let inFlight = false;
  let queued = false;
  let stopped = false;
  let next: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    if (stopped) return;
    next = setTimeout(() => pass(), catchUpIntervalMs);
    next.unref?.();
  };
  const pass = (): void => {
    if (stopped) return;
    inFlight = true;
    void sweeper.sweep().finally(() => {
      inFlight = false;
      if (queued && !stopped) {
        queued = false;
        pass();
        return;
      }
      schedule();
    });
  };
  const trigger = (): void => {
    if (stopped) return;
    // Queued rather than dropped: the running pass may have listed the contracts
    // before this one was funded.
    if (inFlight) queued = true;
    else {
      if (next) clearTimeout(next);
      pass();
    }
  };
  schedule();
  return {
    trigger,
    stop: () => {
      stopped = true;
      queued = false;
      if (next) clearTimeout(next);
    },
  };
}
