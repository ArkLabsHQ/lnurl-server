// FixedFloat order status, for operators and for the deposit txid that references a
// settled token-deposit payment. Nothing here can settle a payment: that comes from the
// corridor swap alone, so a third party's status can never credit what the receiver
// was not paid.

import type { Logger } from "../logger.js";
import { FfBudgetError, type FfClient, type FfOrder } from "../rails/fixedfloat/client.js";
import { chainTxid, namespaceOf } from "../rails/fixedfloat/catalogue.js";
import type { FfOrderStore, StoredFfOrder } from "../ff-order-store.js";
import { startCatchUpLoop, type CatchUpLoop } from "./catch-up-loop.js";

/** Store what FixedFloat says about one order, logging a transition worth an operator's eye. */
export function recordOrder(orders: FfOrderStore, stored: StoredFfOrder, fresh: FfOrder, logger: Logger): void {
  if (fresh.id !== stored.orderId) {
    logger.warn("ff_order_mismatch", { orderId: stored.orderId, answeredFor: fresh.id });
    return;
  }
  const depositTxid = fresh.from.txid ? chainTxid(namespaceOf(stored.asset), fresh.from.txid) ?? null : null;
  const { changed } = orders.recordStatus(stored.paymentHash, { status: fresh.status, emergency: fresh.emergency, depositTxid });
  if (!changed) return;
  const fields = { orderId: stored.orderId, ffCode: stored.ffCode, status: fresh.status };
  if (fresh.status === "EMERGENCY") {
    logger.error("ff_order_emergency", { ...fields, emergency: fresh.emergency?.status ?? [], choice: fresh.emergency?.choice ?? "NONE" });
  } else if (fresh.status === "EXPIRED") {
    logger.error("ff_order_status", fields);
  } else if (fresh.status === "DONE") {
    logger.info("ff_order_status", fields);
  }
}

interface PollDeps { orders: FfOrderStore; client: FfClient; logger: Logger }

/** One pass over the open orders. A failed call leaves its order for the next pass; an
 *  exhausted budget ends the pass, since every remaining call would fail the same way. */
export async function pollFfOrders(deps: PollDeps, opts: { expired: boolean } = { expired: true }): Promise<void> {
  for (const stored of deps.orders.listOpen()) {
    if (stored.status === "EXPIRED" && !opts.expired) continue;
    let fresh: FfOrder;
    try {
      fresh = await deps.client.order(stored.orderId, stored.token);
    } catch (error) {
      if (error instanceof FfBudgetError) return;
      deps.logger.warn("ff_order_poll_failed", { orderId: stored.orderId, error });
      continue;
    }
    recordOrder(deps.orders, stored, fresh, deps.logger);
  }
}

/** An expired order is asked about every tenth pass only: a late deposit is rare, but it is
 *  exactly the payer whose tokens are stuck. */
export function startFfOrderPoller(deps: PollDeps & { intervalMs: number }): CatchUpLoop {
  let pass = 0;
  return startCatchUpLoop({
    pass: () => pollFfOrders(deps, { expired: pass++ % 10 === 0 }),
    intervalMs: deps.intervalMs,
    onError: (error) => deps.logger.warn("ff_order_poll_failed", { error }),
  });
}

/** The offline poller's hook for a newly settled swap. A token deposit is referenced by the
 *  payer's own deposit txid; when the order poller has not seen it yet, ask FixedFloat once. */
export function ffReferenceOnSettle(deps: { orders: FfOrderStore; client: FfClient; logger: Logger }): (paymentHash: string) => Promise<void> {
  return async (paymentHash) => {
    const stored = deps.orders.byPaymentHash(paymentHash);
    if (!stored || deps.orders.fillReference(paymentHash)) return;
    recordOrder(deps.orders, stored, await deps.client.order(stored.orderId, stored.token), deps.logger);
  };
}
