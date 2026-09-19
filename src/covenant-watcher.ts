// Settlement for per-payment covenant destinations. The script belongs to exactly one
// record, so a payment there needs no correlation — and the contract manager already
// pushes an event when one lands, so nothing here polls.
//
// The static-address rail still needs arkade-watcher.ts: those payments arrive at an
// address the server does not control, with only amount and arrival time to go on.

import { isContractVtxoEvent, type IContractManager } from "@arkade-os/sdk";
import type { SettlementStore } from "./settlement-store.js";
import { COVENANT_CONTRACT_TYPE } from "./covenant-contract.js";

/** Settle `record` from any output at its script that covers the agreed amount. */
function settleFrom(
  store: SettlementStore,
  script: string,
  vtxos: readonly { txid: string; value: number }[],
): number {
  const record = store.listPendingDestinations().find((p) => p.covenantScript === script);
  if (!record) return 0;
  for (const v of vtxos) {
    // An under-payment must never flip `settled`, exactly as on the static rail.
    if (v.value * 1000 < record.amountMsat) continue;
    if (store.markObserved(record.paymentHash, v.txid)) return 1;
  }
  return 0;
}

/**
 * Subscribe for covenant-destination payments. Returns an unsubscribe function.
 *
 * The catch-up pass repeats for two reasons rather than one: a payment landing while
 * the process is down produces no event when it comes back, and the SDK subscription
 * drops and reconnects in normal operation, so an arrival inside that window is never
 * pushed either. Re-armed after each pass finishes, not on a fixed interval, so a
 * slow pass cannot stack on itself.
 */
export function startCovenantWatcher(store: SettlementStore, contracts: IContractManager, catchUpIntervalMs = 15_000): () => void {
  const unsubscribe = contracts.onContractEvent((event) => {
    if (event.type !== "vtxo_received" || !isContractVtxoEvent(event) || event.contract.type !== COVENANT_CONTRACT_TYPE) return;
    settleFrom(store, event.contractScript, event.vtxos);
  });

  let stopped = false;
  let next: ReturnType<typeof setTimeout> | undefined;
  const runCatchUp = async (): Promise<void> => {
    try {
      await catchUp(store, contracts);
    } catch (err) {
      console.warn("covenant watcher: catch-up pass failed; retrying:", err);
    }
    if (stopped) return;
    next = setTimeout(() => void runCatchUp(), catchUpIntervalMs);
    next.unref?.();
  };
  void runCatchUp();

  return () => {
    stopped = true;
    if (next) clearTimeout(next);
    unsubscribe();
  };
}

/** Settle anything already funded at subscribe time — the events for those are gone. */
export async function catchUp(store: SettlementStore, contracts: IContractManager): Promise<number> {
  let settled = 0;
  for (const { contract, vtxos } of await contracts.getContractsWithVtxos({ type: COVENANT_CONTRACT_TYPE })) {
    settled += settleFrom(store, contract.script, vtxos);
  }
  return settled;
}
