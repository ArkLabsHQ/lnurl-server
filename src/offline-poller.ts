import type { SettlementStore } from "./settlement-store.js";
import type { OfflineSwapCreator } from "./intent-swap.js";
import type { OfflineSwapStore } from "./offline-swap-store.js";
import { createLogger, type Logger } from "./logger.js";

/** One settlement pass: mark any pending offline swap settled once the solver reports
 *  its invoice settled. The server already holds the preimage, so `verify` can then
 *  reveal it. Returns how many swaps were newly settled. A transient status-check
 *  failure leaves the swap pending for the next pass. Under OFFLINE_SELF_CLAIM the
 *  pass first tries to claim the lockup itself; that is what makes the solver settle. */
export async function settleOfflineSwaps(
  store: SettlementStore,
  creator: OfflineSwapCreator,
  recovered?: OfflineSwapStore,
  logger: Logger = createLogger(),
): Promise<number> {
  let settled = 0;
  const pending: Array<{ swapId: string; paymentHash: string; preimage: string; recovery?: import("./intent-swap.js").OfflineSwapRecoveryV1 }> = recovered
    ? recovered.listPending().map((row) => ({ ...row, swapId: row.recovery.rfqId }))
    : store.listPendingSwaps();
  await creator.prune?.(pending.map((row) => row.swapId));
  for (const p of pending) {
    // Its own try: the claim precedes settlement, so a claim that keeps failing
    // must never stop the status check that would otherwise resolve the swap.
    if (creator.selfClaim) {
      try {
        const outcome = await creator.selfClaim(p.swapId, p.preimage, p.recovery);
        if (outcome.state === "claimed") {
          logger.info("offline_swap_self_claimed", { swapId: p.swapId, arkTxid: outcome.arkTxid });
        } else if (outcome.reason === "underfunded") {
          logger.warn("offline_swap_underfunded", { swapId: p.swapId });
        }
      } catch (err) {
        logger.warn("offline_swap_self_claim_failed", { swapId: p.swapId, error: err });
      }
    }
    try {
      if (await creator.isSettled(p.swapId, p.recovery)) {
        (recovered ?? store).markSettled(p.paymentHash, p.preimage);
        await creator.release?.(p.swapId);
        settled++;
      }
    } catch (err) {
      // Left pending for the next tick, but not silently: this also catches a
      // solver that answers and refuses, which no later tick resolves.
      logger.warn("offline_swap_status_failed", { swapId: p.swapId, error: err });
    }
  }
  return settled;
}

/** Run {@link settleOfflineSwaps} on an interval. Returns a stop function. */
export function startOfflineSettlementPoller(
  store: SettlementStore,
  creator: OfflineSwapCreator,
  intervalMs: number,
  recovered?: OfflineSwapStore,
  logger: Logger = createLogger(),
): () => void {
  let inFlight = false;
  const timer = setInterval(() => {
    // A slow solver must not stack overlapping passes.
    if (inFlight) return;
    inFlight = true;
    void settleOfflineSwaps(store, creator, recovered, logger).finally(() => {
      inFlight = false;
    });
  }, intervalMs);
  // Don't keep the process alive just for polling.
  timer.unref?.();
  return () => clearInterval(timer);
}
