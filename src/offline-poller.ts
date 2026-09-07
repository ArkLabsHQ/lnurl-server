import type { SettlementStore } from "./settlement-store.js";
import type { OfflineSwapCreator } from "./intent-swap.js";

/** One settlement pass: mark any pending offline swap settled once the solver reports
 *  its invoice settled. The server already holds the preimage, so `verify` can then
 *  reveal it. Returns how many swaps were newly settled. A transient status-check
 *  failure leaves the swap pending for the next pass. Under OFFLINE_SELF_CLAIM the
 *  pass first tries to claim the lockup itself; that is what makes the solver settle. */
export async function settleOfflineSwaps(store: SettlementStore, creator: OfflineSwapCreator): Promise<number> {
  let settled = 0;
  for (const p of store.listPendingSwaps()) {
    // Its own try: the claim precedes settlement, so a claim that keeps failing
    // must never stop the status check that would otherwise resolve the swap.
    if (creator.selfClaim) {
      try {
        const outcome = await creator.selfClaim(p.swapId, p.preimage);
        if (outcome.state === "claimed") {
          console.log(`offline settlement: self-claimed lockup for swap ${p.swapId} (ark tx ${outcome.arkTxid})`);
        } else if (outcome.reason === "underfunded") {
          console.warn(`offline settlement: lockup for swap ${p.swapId} is underfunded — not revealing the preimage`);
        }
      } catch (err) {
        console.warn(`offline settlement: self-claim failed for swap ${p.swapId}:`, err);
      }
    }
    try {
      if (await creator.isSettled(p.swapId)) {
        store.markSettled(p.paymentHash, p.preimage);
        settled++;
      }
    } catch (err) {
      // Left pending for the next tick, but not silently: this also catches a
      // solver that answers and refuses, which no later tick resolves.
      console.warn(`offline settlement: status check failed for swap ${p.swapId}:`, err);
    }
  }
  return settled;
}

/** Run {@link settleOfflineSwaps} on an interval. Returns a stop function. */
export function startOfflineSettlementPoller(
  store: SettlementStore,
  creator: OfflineSwapCreator,
  intervalMs: number,
): () => void {
  let inFlight = false;
  const timer = setInterval(() => {
    // A slow solver must not stack overlapping passes.
    if (inFlight) return;
    inFlight = true;
    void settleOfflineSwaps(store, creator).finally(() => {
      inFlight = false;
    });
  }, intervalMs);
  // Don't keep the process alive just for polling.
  timer.unref?.();
  return () => clearInterval(timer);
}
