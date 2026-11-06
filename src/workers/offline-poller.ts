import type { SettlementStore } from "../settlement-store.js";
import { CLOSED_RFQ_STATES, type OfflineSwapCreator } from "../services/offline-swaps.js";
import type { OfflineSwapStore } from "../offline-swap-store.js";
import { createLogger, type Logger } from "../logger.js";
import { startCatchUpLoop } from "./catch-up-loop.js";

type Pending = { swapId: string; paymentHash: string; preimage: string; recovery?: import("../services/offline-swaps.js").OfflineSwapRecoveryV1 };

export interface SettlementHooks {
  /** After a swap newly settles. A failure is logged, never fatal: the swap stays settled. */
  onSettled?: (paymentHash: string) => Promise<void>;
}

function pendingSwaps(store: SettlementStore, recovered?: OfflineSwapStore): Pending[] {
  return recovered
    ? recovered.listPending().map((row) => ({ ...row, swapId: row.recovery.rfqId }))
    : store.listPendingSwaps();
}

async function solverState(creator: OfflineSwapCreator, p: Pending): Promise<string | undefined> {
  if (creator.status) return creator.status(p.swapId, p.recovery);
  return (await creator.isSettled(p.swapId, p.recovery)) ? "settled" : undefined;
}

/** This lockup's payout to the receiver, recorded. A failed read is not "no payout". */
async function recordPayout(store: SettlementStore, creator: OfflineSwapCreator, p: Pending, logger: Logger, swapRef: string): Promise<boolean> {
  let arkTxid: string | undefined;
  try {
    arkTxid = await creator.observePayout(p.swapId, p.recovery);
  } catch (error) {
    logger.warn("offline_swap_payout_observe_failed", { swapRef, error });
    return false;
  }
  if (!arkTxid) return false;
  // Quiet on the expected retry (an earlier pass got there first); loud when the row is gone.
  if (!store.markPaidOut(p.paymentHash, arkTxid) && !store.get(p.paymentHash)?.payoutReference) {
    logger.warn("offline_swap_payout_unrecorded", { swapRef, arkTxid });
  }
  return true;
}

async function settleOne(store: SettlementStore, creator: OfflineSwapCreator, p: Pending, recovered: OfflineSwapStore | undefined, logger: Logger, hooks: SettlementHooks, expired: Set<string>, closed: Set<string>): Promise<boolean> {
  // The logger redacts 64-char hex, which is exactly what a swap id is.
  const swapRef = p.swapId.slice(0, 12);
  let claimed = false;
  if (creator.selfClaim && !expired.has(p.swapId)) {
    try {
      const outcome = await creator.selfClaim(p.swapId, p.preimage, p.recovery);
      if (outcome.state === "claimed") {
        store.markPaidOut(p.paymentHash, outcome.arkTxid);
        claimed = true;
        logger.info("offline_swap_self_claimed", { swapRef, arkTxid: outcome.arkTxid });
      } else if (outcome.reason === "underfunded") {
        logger.warn("offline_swap_underfunded", { swapRef });
      } else if (outcome.reason === "expired") {
        expired.add(p.swapId);
        if (outcome.funded) logger.error("offline_swap_refund_deadline_passed", { swapRef });
        else logger.info("offline_swap_expired_unpaid", { swapRef });
      }
    } catch (err) {
      logger.warn("offline_swap_self_claim_failed", { swapRef, error: err });
    }
  }
  if (closed.has(p.swapId) && !claimed) return false;
  try {
    const state = claimed ? "settled" : await solverState(creator, p);
    if (state === "settled") {
      // The solver is the counterparty P pays, so its word would settle the swap and reveal P
      // as proof of a receive that never arrived. Only a payout read off the chain is evidence
      // — whoever pushed the claim. The expired cache is dropped so a late one is still found.
      if (!claimed && !(await recordPayout(store, creator, p, logger, swapRef))) {
        expired.delete(p.swapId);
        logger.warn("offline_swap_settled_without_payout", { swapRef });
        return false;
      }
      const settled = (recovered ?? store).markSettled(p.paymentHash, p.preimage);
      await creator.release?.(p.swapId);
      if (settled) await hooks.onSettled?.(p.paymentHash).catch((error) => logger.warn("offline_swap_settled_hook_failed", { swapRef, error }));
      return settled;
    }
    if (state !== undefined && CLOSED_RFQ_STATES.has(state)) {
      closed.add(p.swapId);
      logger.info("offline_swap_closed", { swapRef, state });
      await creator.release?.(p.swapId);
    }
  } catch (err) {
    logger.warn("offline_swap_status_failed", { swapRef, error: err });
  }
  return false;
}

/** A claim whose reply was lost settles the swap with no payout reference, and the pending read
 *  never returns to a settled row. One attempt each: a landed payout is visible at once. Prefers
 *  the claim path, so a settled row whose lockup is still spendable is claimed — money the user
 *  is owed. Every mode runs it: it is also the upgrade path for a row settled by an older build,
 *  whose preimage `revealedPreimage` withholds until a payout is recorded. */
async function recordMissedPayouts(store: SettlementStore, creator: OfflineSwapCreator, recovered: OfflineSwapStore, logger: Logger, asked: Set<string>): Promise<void> {
  const rows = recovered.listUnrecordedPayouts();
  const live = new Set(rows.map((row) => row.paymentHash));
  for (const paymentHash of asked) if (!live.has(paymentHash)) asked.delete(paymentHash);
  for (const row of rows) {
    if (asked.has(row.paymentHash)) continue;
    const swapRef = row.recovery.rfqId.slice(0, 12);
    try {
      let arkTxid: string | undefined;
      if (creator.selfClaim) {
        const outcome = await creator.selfClaim(row.recovery.rfqId, row.preimage, row.recovery);
        if (outcome.state === "claimed") arkTxid = outcome.arkTxid;
      } else {
        arkTxid = await creator.observePayout(row.recovery.rfqId, row.recovery);
      }
      asked.add(row.paymentHash);
      if (arkTxid !== undefined && store.markPaidOut(row.paymentHash, arkTxid)) {
        logger.info("offline_swap_payout_recorded", { swapRef, arkTxid });
      }
    } catch (error) {
      logger.warn("offline_swap_payout_lookup_failed", { swapRef, error });
    }
  }
}

/** One settlement pass: mark any pending offline swap settled once the solver reports
 *  its invoice settled. The server already holds the preimage, so `verify` can then
 *  reveal it. Returns how many swaps were newly settled. A transient status-check
 *  failure leaves the swap pending for the next pass. The pass first tries to claim
 *  the lockup itself; that is what makes the solver settle. */
export async function settleOfflineSwaps(
  store: SettlementStore,
  creator: OfflineSwapCreator,
  recovered?: OfflineSwapStore,
  logger: Logger = createLogger(),
  hooks: SettlementHooks = {},
): Promise<number> {
  let settled = 0;
  const pending = pendingSwaps(store, recovered);
  await creator.prune?.(pending.map((row) => row.swapId));
  for (const p of pending) {
    if (await settleOne(store, creator, p, recovered, logger, hooks, new Set(), new Set())) settled++;
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
  hooks: SettlementHooks = {},
): OfflineSettlementPoller {
  const running = new Map<string, Promise<boolean>>();
  const queued = new Set<string>();
  const retry = new Set<string>();
  // Past their refund deadline: wall clock only moves on, so the claim's answer cannot change.
  // The solver is still asked — a claim made before the deadline can settle after it.
  const expired = new Set<string>();
  // The solver will never settle these. Claims go on until the deadline, in case it is wrong.
  const closed = new Set<string>();
  const asked = new Set<string>();
  let active = 0;
  let stopped = false;
  const runOne = (p: Pending): Promise<boolean> => {
    const existing = running.get(p.swapId);
    if (existing) return existing;
    const task = Promise.resolve()
      .then(() => store.get(p.paymentHash)?.settled === false ? settleOne(store, creator, p, recovered, logger, hooks, expired, closed) : false)
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
      const live = new Set(pending.map((row) => row.swapId));
      for (const set of [expired, closed]) for (const swapId of set) if (!live.has(swapId)) set.delete(swapId);
      for (const p of pending) await runOne(p);
      if (recovered) await recordMissedPayouts(store, creator, recovered, logger, asked);
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
