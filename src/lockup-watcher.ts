// The solver's lockup, watched rather than polled. Our claim is what makes the solver
// settle the hold invoice, so every second between funding and claim is one the payer
// spends watching a spinner.
//
// No catch-up pass of its own: startOfflineSettlementPoller runs one immediately, and
// it asks the indexer directly — a stronger answer than the contract store's copy.

import { ArkAddress, isContractVtxoEvent, type IContractManager } from "@arkade-os/sdk";
import { SWAP_LOCKUP_CONTRACT_TYPE } from "@arkade-os/swap";
import { hex } from "@scure/base";
import type { OfflineSwapStore } from "./offline-swap-store.js";
import { createLogger, type Logger } from "./logger.js";

/** Pending lockups keyed the way contract rows and events are: by pkScript hex. */
function pendingScripts(swaps: OfflineSwapStore): Set<string> {
  const scripts = new Set<string>();
  for (const row of swaps.listPending()) {
    try {
      scripts.add(hex.encode(ArkAddress.decode(row.recovery.lockupAddress).pkScript));
    } catch {
      // Only costs this row its fast path; the poller still claims it by script.
    }
  }
  return scripts;
}

/** After a claim, the solver settles a moment later; re-asking beats waiting out the catch-up. */
const SPENT_RECHECK_MS = [1000, 3000];

/**
 * Subscribe for solver funding or claim of a pending swap's lockup, calling `trigger` — a
 * settlement pass — as soon as one lands. Returns an unsubscribe function. The poller
 * stays the net under a subscription that drops or never starts: faster, not instead.
 */
export function startLockupWatcher(
  contracts: IContractManager,
  swaps: OfflineSwapStore,
  trigger: () => void,
  logger: Logger = createLogger(),
): () => void {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const unsubscribe = contracts.onContractEvent((event) => {
    const spent = event.type === "vtxo_spent";
    if ((event.type !== "vtxo_received" && !spent) || !isContractVtxoEvent(event) || event.contract.type !== SWAP_LOCKUP_CONTRACT_TYPE) return;
    try {
      if (!pendingScripts(swaps).has(event.contractScript)) return;
    } catch (error) {
      // Throwing here would drop the event for every swap, and the SDK would only log it.
      logger.warn("offline_lockup_match_failed", { script: event.contractScript, error });
      return;
    }
    logger.info(spent ? "offline_lockup_spent" : "offline_lockup_funded", { script: event.contractScript });
    trigger();
    if (spent) for (const ms of SPENT_RECHECK_MS) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        trigger();
      }, ms);
      timer.unref?.();
      timers.add(timer);
    }
  });
  return () => {
    unsubscribe();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
}
