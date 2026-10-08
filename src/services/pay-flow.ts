import { BIP21 } from "@arkade-os/sdk";
import type { SessionManager } from "./sessions.js";
import type { SettlementStore } from "../settlement-store.js";
import type { OfflineSwapCreator, OfflineSwapResult } from "./offline-swaps.js";
import type { OfflineSwapStore } from "../offline-swap-store.js";
import type { Logger } from "../logger.js";
import type { PaymentQuote } from "../quote-provider.js";
import { InvoiceRequestError, RailRefusedError } from "../errors.js";
import { paymentHashFromBolt11 } from "../bolt11.js";
import type { LnurlPayCallbackResponse, LnurlPayDestinationResponse } from "../types/index.js";
import { LnurlError } from "../http/errors.js";
import { BATCH_PATH } from "./verify-batch.js";
import type { FixedFloatDeps } from "../rails/fixedfloat/provider.js";
import type { FfRail } from "../rails/fixedfloat/rates.js";
import { FfApiError, FfBudgetError, type FfOrder } from "../rails/fixedfloat/client.js";
import { isValidAddress, namespaceOf } from "../rails/fixedfloat/catalogue.js";
import { baseUnits, ffPaymentQuote } from "../rails/fixedfloat/quote.js";
import { tokenPaymentUri } from "../rails/fixedfloat/uri.js";

const METADATA_DESCRIPTION = "Arkade LNURL Receive";

export function buildMetadata(identifier?: string): string {
  const entries: [string, string][] = [["text/plain", METADATA_DESCRIPTION]];
  if (identifier) entries.push(["text/identifier", identifier]);
  return JSON.stringify(entries);
}

/** A payable URI for a destination-rail quote. The Arkade destination goes in
 *  `ark=` rather than the address slot, which BIP21 reserves for an onchain one,
 *  and `amount` is BTC per the scheme even though everything else here is msat. */
export function destinationUri(paymentOption: string, destination: string, amountMsat: number): string {
  const amount = amountMsat / 1000 / 100_000_000;
  return paymentOption === "onchain"
    ? BIP21.create({ address: destination, amount })
    : BIP21.create({ ark: destination, amount });
}

/** Ask the wallet behind a live session for a bolt11 and record it for LUD-21 verify. */
export async function requestSessionInvoice(args: {
  sessions: SessionManager;
  sessionId: string;
  addressId?: number;
  amountMsat: number;
  comment: string | undefined;
  min: number;
  max: number;
  timeoutMs: number;
  offlineReason: string;
  store: SettlementStore;
  baseUrl: string;
  paymentQuote?: PaymentQuote;
  /** LUD-XX: echo the explicitly-selected lightning option on the pr response. */
  echoLightningOption?: boolean;
  logger: Logger;
  requestId: string;
}): Promise<LnurlPayCallbackResponse> {
  const { sessions, sessionId, addressId, amountMsat, comment, min, max, timeoutMs, offlineReason, store, baseUrl, paymentQuote, echoLightningOption, logger, requestId } = args;
  if (amountMsat < min || amountMsat > max) {
    throw new LnurlError(`Amount must be between ${min} and ${max} millisats`);
  }
  if (!sessions.isActive(sessionId)) {
    throw new LnurlError(offlineReason);
  }
  try {
    const pr = await sessions.requestInvoice(sessionId, amountMsat, comment, timeoutMs);
    // LUD-21: record the invoice and hand the payer a verify URL. If the bolt11 can't be
    // decoded we can't key a record, so we omit verify but still return the pr.
    const paymentHash = paymentHashFromBolt11(pr);
    if (paymentHash) store.create({ paymentHash, pr, sessionId, amountMsat, addressId });
    return {
      pr,
      routes: [],
      ...(paymentHash ? { verify: `${baseUrl}/lnurl/verify/${paymentHash}`, verifyBatch: `${baseUrl}${BATCH_PATH}` } : {}),
      ...(paymentQuote ? { paymentQuote } : {}),
      ...(echoLightningOption ? { paymentOption: "lightning" } : {}),
    };
  } catch (err) {
    if (err instanceof InvoiceRequestError) throw new LnurlError(err.message);
    logger.error("invoice_request_failed", { requestId, error: err });
    throw new LnurlError("Failed to get invoice");
  }
}

// Create a solver-mediated receive swap for an offline receiver: the hold invoice + a
// LUD-21 verify URL. The preimage is held in the store (unrevealed until
// the settlement poller flips it) keyed by the swap's payment hash. It is safe at
// rest because the covenant's `enforcePayTo` pins the claim to the user's address —
// learning the preimage cannot redirect funds.
export async function createOfflineSwapInvoice(args: {
  creator: OfflineSwapCreator;
  store: SettlementStore;
  offlineSwaps?: OfflineSwapStore;
  baseUrl: string;
  amountMsat: number;
  receiveAddress: string;
  claimPublicKey: string;
  addressId: number;
  paymentQuote?: PaymentQuote;
  /** LUD-XX: echo the explicitly-selected lightning option on the pr response. */
  echoLightningOption?: boolean;
  logger: Logger;
  requestId: string;
}): Promise<LnurlPayCallbackResponse> {
  const { creator, store, offlineSwaps, baseUrl, amountMsat, receiveAddress, claimPublicKey, addressId, paymentQuote, echoLightningOption, logger, requestId } = args;
  try {
    // Caller guarantees whole satoshis (rejected at the route otherwise).
    const swap = await creator.create({ amountSat: amountMsat / 1000, receiveAddress, claimPublicKey });
    const accepted = { paymentHash: swap.preimageHash, pr: swap.invoice, sessionId: `offline:${addressId}`, preimage: swap.preimage, amountMsat, addressId };
    // With DB_PATH, OfflineSwapStore is the single atomic persistence boundary:
    // it writes both settlement and restart recovery rows in one transaction.
    if (offlineSwaps) offlineSwaps.createAccepted({ ...accepted, recovery: swap.recovery });
    else store.create({ ...accepted, swapId: swap.swapId });
    return {
      pr: swap.invoice,
      routes: [],
      verify: `${baseUrl}/lnurl/verify/${swap.preimageHash}`,
      verifyBatch: `${baseUrl}${BATCH_PATH}`,
      ...(paymentQuote ? { paymentQuote } : {}),
      ...(echoLightningOption ? { paymentOption: "lightning" } : {}),
    };
  } catch (err) {
    logger.warn("offline_quote_failed", { requestId, error: err });
    const reason = err instanceof RailRefusedError ? err.message : "Unable to create offline invoice";
    throw new LnurlError(reason);
  }
}

/** Why a created order cannot be handed to a payer, if it cannot. Past `create`, so a
 *  refusal leaves an order nobody funds: it expires on the provider's side. */
function orderRefusal(order: FfOrder, rail: FfRail, toSat: number): string | undefined {
  if (order.type !== "fixed") return "order is not fixed-rate";
  if (order.from.code !== rail.ffCode || order.to.code !== "BTCLN") return "order is for a different pair";
  if (baseUnits(order.to.amount, 8) !== String(toSat)) return "order delivers a different amount than the invoice";
  if (!baseUnits(order.from.amount, rail.decimals)) return "deposit amount does not fit the token's decimals";
  if (!isValidAddress(namespaceOf(rail.asset), order.from.address)) return "deposit address is not an address of the token's chain";
  // No advertised chain's URI can carry a memo, and a deposit without one is lost.
  if (order.from.tag) return "deposit needs a memo tag";
  if (order.expiresAt === undefined) return "order states no deadline";
  return undefined;
}

/** A token deposit (spec §4.1): price, corridor swap, deadline gate, FixedFloat order,
 *  guards, one transaction. Ordered so the cheapest refusal comes first and nothing
 *  irreversible happens before the last guard that can run without it. The route has
 *  already gated the option, the amount and the open-order cap. */
export async function createFixedFloatDestination(args: {
  ff: FixedFloatDeps;
  rail: FfRail;
  creator: OfflineSwapCreator;
  amountMsat: number;
  receiveAddress: string;
  claimPublicKey: string;
  addressId: number;
  baseUrl: string;
  logger: Logger;
  requestId: string;
  /** Told when the provider cannot route the corridor invoice (FixedFloat's 304). */
  onUnroutable?: () => void;
}): Promise<LnurlPayDestinationResponse> {
  const { ff, rail, creator, amountMsat, receiveAddress, claimPublicKey, addressId, baseUrl, logger, requestId } = args;
  const id = rail.optionId;
  const toSat = amountMsat / 1000;
  const busy = () => {
    logger.warn("ff_budget_exhausted", { requestId, optionId: id });
    return new LnurlError(`paymentOption ${id} is busy, try again shortly`, 429);
  };
  const refuse = (reason: string, fields: Record<string, unknown> = {}) => {
    logger.warn("ff_quote_refused", { requestId, optionId: id, sats: toSat, reason, ...fields });
    return new LnurlError(`paymentOption ${id} is unavailable for this request`);
  };
  const reservation = ff.client.reserveCreate();
  if (!reservation) throw busy();
  try {
    const price = await ff.client.price({ fromCcy: rail.ffCode, toSat });
    if (price.errors.length > 0) {
      logger.warn("ff_quote_refused", { requestId, optionId: id, sats: toSat, reason: "price", errors: price.errors });
      throw new LnurlError(price.errors.some((e) => e.startsWith("LIMIT_"))
        ? `Amount is outside what ${ff.provider.label} accepts for ${id} right now`
        : `paymentOption ${id} is unavailable right now`);
    }
    if (price.fromCode !== rail.ffCode || baseUnits(price.toAmount, 8) !== String(toSat)) throw refuse("price answered for another pair or amount");

    let swap: OfflineSwapResult;
    try {
      swap = await creator.create({ amountSat: toSat, receiveAddress, claimPublicKey });
    } catch (err) {
      logger.warn("offline_quote_failed", { requestId, error: err });
      throw new LnurlError(err instanceof RailRefusedError ? err.message : "Unable to create offline invoice");
    }
    // The payer's deadline ends a margin before the invoice's, so the provider still has
    // time to pay it. A deposit after that, but inside the provider's own longer window,
    // may find the invoice dead and lands in the provider's emergency/refund flow; the
    // order poller keeps watching expired orders so that case is reported.
    const payBy = swap.invoiceExpiresAt === undefined ? undefined : swap.invoiceExpiresAt - ff.settleMarginSeconds;
    const before = Math.floor(Date.now() / 1000);
    if (payBy === undefined || payBy - before < ff.minPayWindowSeconds) {
      throw refuse("the invoice leaves too short a pay window", { paySecondsLeft: payBy === undefined ? null : payBy - before });
    }

    const order = await ff.client.create({ fromCcy: rail.ffCode, toSat, toAddress: swap.invoice }, reservation);
    const now = Math.floor(Date.now() / 1000);
    const refusal = orderRefusal(order, rail, toSat)
      ?? (Math.min(order.expiresAt!, payBy) - now < ff.minPayWindowSeconds ? "the order leaves too short a pay window" : undefined);
    const quote = refusal ? undefined : ffPaymentQuote({
      amountMsat, order, rail, toAmountSat: swap.recovery.expectedAmount, payBy, ...(price.fromBtc ? { fromBtc: price.fromBtc } : {}),
    });
    if (!quote || order.expiresAt === undefined) throw refuse(refusal ?? "no quote", { orderId: order.id });

    ff.orders.createAccepted({
      paymentHash: swap.preimageHash, pr: swap.invoice, sessionId: `offline:${addressId}`, preimage: swap.preimage, amountMsat, addressId,
      paymentOption: id, recovery: swap.recovery,
      order: {
        id: order.id, token: order.token, ffCode: rail.ffCode, asset: rail.asset, unit: rail.unit, depositAddress: order.from.address,
        depositAmount: quote.payment.amount, toAmountSat: toSat, status: order.status, expiresAt: order.expiresAt,
      },
    });
    logger.info("ff_order_created", { requestId, orderId: order.id, ffCode: rail.ffCode, unit: rail.unit, sats: toSat });
    const uri = tokenPaymentUri(rail.asset, order.from.address, quote.payment.amount, rail.decimals);
    return {
      status: "OK",
      paymentOption: id,
      paymentDestination: order.from.address,
      ...(uri ? { paymentURI: uri } : {}),
      provider: ff.provider.label,
      paymentQuote: quote,
      verify: `${baseUrl}/lnurl/verify/${swap.preimageHash}`,
      verifyBatch: `${baseUrl}${BATCH_PATH}`,
    };
  } catch (err) {
    if (err instanceof LnurlError) throw err;
    if (err instanceof FfBudgetError) throw busy();
    if (err instanceof FfApiError) {
      if (err.code === 304) args.onUnroutable?.();
      throw refuse(`${ff.provider.label} ${err.method} refused`, { code: err.code, error: err });
    }
    logger.error("ff_quote_failed", { requestId, optionId: id, error: err });
    throw new LnurlError(`paymentOption ${id} is unavailable for this request`);
  } finally {
    reservation.release();
  }
}
