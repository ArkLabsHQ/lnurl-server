import type { SettlementStore } from "../settlement-store.js";
import type { OfflineSwapCreator } from "../services/offline-swaps.js";
import type { OfflineSwapStore } from "../offline-swap-store.js";
import { createLogger, type Logger } from "../logger.js";
import { startCatchUpLoop } from "./catch-up-loop.js";

type Pending = { swapId: string; paymentHash: string; preimage: string; recovery?: import("../services/offline-swaps.js").OfflineSwapRecoveryV1 };

function pendingSwaps(store: SettlementStore, recovered?: OfflineSwapStore): Pending[] {
  return recovered
    ? recovered.listPending().map((row) => ({ ...row, swapId: row.recovery.rfqId }))
    : store.listPendingSwaps();
}

async function settleOne(store: SettlementStore, creator: OfflineSwapCreator, p: Pending, recovered: OfflineSwapStore | undefined, logger: Logger): Promise<boolean> {
  let claimed = false;
  if (creator.selfClaim) {
    try {
      const outcome = await creator.selfClaim(p.swapId, p.preimage, p.recovery);
      if (outcome.state === "claimed") {
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
    if (claimed || await creator.isSettled(p.swapId, p.recovery)) {
      const settled = (recovered ?? store).markSettled(p.paymentHash, p.preimage);
      await creator.release?.(p.swapId);
      return settled;
    }
  } catch (err) {
    logger.warn("offline_swap_status_failed", { swapId: p.swapId, error: err });
  }
  return false;
}

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
  const pending = pendingSwaps(store, recovered);
  await creator.prune?.(pending.map((row) => row.swapId));
  for (const p of pending) {
    if (await settleOne(store, creator, p, recovered, logger)) settled++;
  }
  return settled;
}

export interface OfflineSettlementPoller {
  /** Run a pass now — for a lockup the watcher saw funded. */
  trigger(swapId?: string): void;
  stop(): void;
}

/**
 * Run {@link settleOfflineSwaps} on demand, with a catch-up behind it.
 *
 * src/workers/lockup-watcher.ts is the mechanism; this covers what no event can. Rescheduled
 * after each pass rather than on a fixed grid, so a slow solver spaces passes out.
 */
export function startOfflineSettlementPoller(
  store: SettlementStore,
  creator: OfflineSwapCreator,
  catchUpIntervalMs: number,
  recovered?: OfflineSwapStore,
  logger: Logger = createLogger(),
): OfflineSettlementPoller {
  const running = new Map<string, Promise<boolean>>();
  const queued = new Set<string>();
  const retry = new Set<string>();
  let active = 0;
  let stopped = false;
  const runOne = (p: Pending): Promise<boolean> => {
    const existing = running.get(p.swapId);
    if (existing) return existing;
    const task = Promise.resolve()
      .then(() => store.get(p.paymentHash)?.settled === false ? settleOne(store, creator, p, recovered, logger) : false)
      .finally(() => {
        running.delete(p.swapId);
        if (retry.delete(p.swapId)) queued.add(p.swapId);
        drain();
      });
    running.set(p.swapId, task);
    return task;
  };
  const drain = (): void => {
    while (!stopped && active < 8 && queued.size > 0) {
      const swapId = queued.values().next().value!;
      queued.delete(swapId);
      if (running.has(swapId)) { retry.add(swapId); continue; }
      let p: Pending | undefined;
      try { p = pendingSwaps(store, recovered).find((row) => row.swapId === swapId); }
      catch (error) { logger.warn("offline_settlement_pass_failed", { error }); continue; }
      if (!p) continue;
      active++;
      void runOne(p)
        .catch((error) => logger.warn("offline_settlement_pass_failed", { error }))
        .finally(() => { active--; drain(); });
    }
  };
  const loop = startCatchUpLoop({
    pass: async () => {
      const pending = pendingSwaps(store, recovered);
      await creator.prune?.(pending.map((row) => row.swapId));
      for (const p of pending) await runOne(p);
    },
    intervalMs: catchUpIntervalMs,
    onError: (error) => logger.warn("offline_settlement_pass_failed", { error }),
    immediate: true,
  });
  return {
    trigger: (swapId) => {
      if (stopped) return;
      if (swapId === undefined) { loop.trigger(); return; }
      if (running.has(swapId)) retry.add(swapId);
      else queued.add(swapId);
      drain();
    },
    stop: () => { stopped = true; queued.clear(); retry.clear(); loop.stop(); },
  };
}
