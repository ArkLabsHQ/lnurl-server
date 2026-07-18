import type { SettlementStore } from "./settlement-store.js";
import type { ReverseSwapCreator } from "./reverse-swap.js";

/** One settlement pass: mark any pending offline swap settled once Boltz reports its
 *  invoice paid. The server already holds the preimage, so `verify` can then reveal it.
 *  Returns how many swaps were newly settled. A transient status-check failure leaves
 *  the swap pending for the next pass. */
export async function settleOfflineSwaps(store: SettlementStore, creator: ReverseSwapCreator): Promise<number> {
  let settled = 0;
  for (const p of store.listPendingSwaps()) {
    try {
      if (await creator.isSettled(p.swapId)) {
        store.markSettled(p.paymentHash, p.preimage);
        settled++;
      }
    } catch {
      // Transient (e.g. Boltz unreachable) — leave pending for the next tick.
    }
  }
  return settled;
}

/** Run {@link settleOfflineSwaps} on an interval. Returns a stop function. */
export function startOfflineSettlementPoller(
  store: SettlementStore,
  creator: ReverseSwapCreator,
  intervalMs: number,
): () => void {
  const timer = setInterval(() => {
    void settleOfflineSwaps(store, creator);
  }, intervalMs);
  // Don't keep the process alive just for polling.
  timer.unref?.();
  return () => clearInterval(timer);
}
