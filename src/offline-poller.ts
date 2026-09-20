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
    let claimed = false;
    if (creator.selfClaim) {
      try {
        const outcome = await creator.selfClaim(p.swapId, p.preimage, p.recovery);
        if (outcome.state === "claimed") {
          // The swap settles on a preimage; the claim is the only txid they hold.
          store.markPaidOut(p.paymentHash, outcome.arkTxid);
          claimed = true;
          logger.info("offline_swap_self_claimed", { swapId: p.swapId, arkTxid: outcome.arkTxid });
        } else if (outcome.reason === "underfunded") {
          logger.warn("offline_swap_underfunded", { swapId: p.swapId });
        } else if (outcome.reason === "expired") {
          logger.error("offline_swap_refund_deadline_passed", { swapId: p.swapId });
        }
      } catch (err) {
        logger.warn("offline_swap_self_claim_failed", { swapId: p.swapId, error: err });
      }
    }
    try {
      // Our claim is what makes the solver settle, so once it lands the solver can
      // only confirm what we already did — at the cost of a remote round trip.
      if (claimed || await creator.isSettled(p.swapId, p.recovery)) {
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

export interface OfflineSettlementPoller {
  /** Run a pass now — for a lockup the watcher saw funded. */
  trigger(): void;
  stop(): void;
}

/**
 * Run {@link settleOfflineSwaps} on demand, with a catch-up behind it.
 *
 * src/lockup-watcher.ts is the mechanism; this covers what no event can. Rescheduled
 * after each pass rather than on a fixed grid, so a slow solver spaces passes out.
 */
export function startOfflineSettlementPoller(
  store: SettlementStore,
  creator: OfflineSwapCreator,
  catchUpIntervalMs: number,
  recovered?: OfflineSwapStore,
  logger: Logger = createLogger(),
): OfflineSettlementPoller {
  let inFlight = false;
  let queued = false;
  let stopped = false;
  let next: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    if (stopped) return;
    next = setTimeout(() => pass(), catchUpIntervalMs);
    // Don't keep the process alive just for the catch-up.
    next.unref?.();
  };
  const pass = (): void => {
    if (stopped) return;
    inFlight = true;
    void settleOfflineSwaps(store, creator, recovered, logger).finally(() => {
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
    // Queued rather than dropped: the running pass may already have looked at this
    // swap and found it unfunded, and the catch-up is a whole interval away.
    if (inFlight) queued = true;
    else {
      if (next) clearTimeout(next);
      pass();
    }
  };
  trigger();
  return {
    trigger,
    stop: () => {
      stopped = true;
      queued = false;
      if (next) clearTimeout(next);
    },
  };
}
