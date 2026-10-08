// FixedFloat order status, for operators and for the deposit txid that references a
// settled token-deposit payment. Nothing here can settle a payment: that comes from the
// corridor swap alone, so a third party's status can never credit what the receiver
// was not paid.

import type { Logger } from "../logger.js";
import type { FfClient, FfOrder } from "../rails/fixedfloat/client.js";
import { chainTxid, namespaceOf } from "../rails/fixedfloat/catalogue.js";
import type { FfOrderStore, StoredFfOrder } from "../ff-order-store.js";

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

/** The offline poller's hook for a newly settled swap. A token deposit is referenced by the
 *  payer's own deposit txid; when the order poller has not seen it yet, ask FixedFloat once. */
export function ffReferenceOnSettle(deps: { orders: FfOrderStore; client: FfClient; logger: Logger }): (paymentHash: string) => Promise<void> {
  return async (paymentHash) => {
    const stored = deps.orders.byPaymentHash(paymentHash);
    if (!stored || deps.orders.fillReference(paymentHash)) return;
    recordOrder(deps.orders, stored, await deps.client.order(stored.orderId, stored.token), deps.logger);
  };
}
