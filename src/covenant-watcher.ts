// Settlement for per-payment covenant destinations. The script belongs to exactly one
// record, so a payment there needs no correlation — and the contract manager already
// pushes an event when one lands, so nothing here polls.
//
// The static-address rail still needs arkade-watcher.ts: those payments arrive at an
// address the server does not control, with only amount and arrival time to go on.

import type { IContractManager } from "@arkade-os/sdk";
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
 * The catch-up pass is not belt-and-braces: a payment that lands while the process is
 * down produces no event when it comes back, and the record would never settle.
 */
export function startCovenantWatcher(store: SettlementStore, contracts: IContractManager): () => void {
  const unsubscribe = contracts.onContractEvent((event) => {
    if (event.type !== "vtxo_received" || event.contract.type !== COVENANT_CONTRACT_TYPE) return;
    settleFrom(store, event.contractScript, event.vtxos);
  });

  void catchUp(store, contracts).catch((err) => {
    // The subscription is already live, so a failure here costs the backlog, not
    // everything after it. Loud because nothing retries it.
    console.warn("covenant watcher: catch-up pass failed, payments made while down stay unsettled:", err);
  });

  return unsubscribe;
}

/** Settle anything already funded at subscribe time — the events for those are gone. */
export async function catchUp(store: SettlementStore, contracts: IContractManager): Promise<number> {
  let settled = 0;
  for (const { contract, vtxos } of await contracts.getContractsWithVtxos({ type: COVENANT_CONTRACT_TYPE })) {
    settled += settleFrom(store, contract.script, vtxos);
  }
  return settled;
}
