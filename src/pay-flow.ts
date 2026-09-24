import type express from "express";
import { BIP21 } from "@arkade-os/sdk";
import type { SessionManager } from "./session-manager.js";
import type { SettlementStore } from "./settlement-store.js";
import type { OfflineSwapCreator } from "./intent-swap.js";
import type { OfflineSwapStore } from "./offline-swap-store.js";
import type { Logger } from "./logger.js";
import type { PaymentQuote } from "./quote-provider.js";
import { RailRefusedError } from "./rails.js";
import { paymentHashFromBolt11 } from "./bolt11.js";
import type { LnurlPayCallbackResponse } from "./types/index.js";
import { LnurlError } from "./http-responses.js";
import { BATCH_PATH } from "./verify-batch.js";

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

// Shared core: validate amount range, ensure session online, request bolt11, respond.
export async function requestInvoiceAndRespond(args: {
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
  res: express.Response;
}): Promise<void> {
  const { sessions, sessionId, addressId, amountMsat, comment, min, max, timeoutMs, offlineReason, store, baseUrl, paymentQuote, echoLightningOption, res } = args;
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
    const echo = echoLightningOption ? { paymentOption: "lightning" } : {};
    if (paymentHash) {
      store.create({ paymentHash, pr, sessionId, amountMsat, addressId });
      res.json({ pr, routes: [], verify: `${baseUrl}/lnurl/verify/${paymentHash}`, verifyBatch: `${baseUrl}${BATCH_PATH}`, ...(paymentQuote ? { paymentQuote } : {}), ...echo } satisfies LnurlPayCallbackResponse);
    } else {
      res.json({ pr, routes: [], ...(paymentQuote ? { paymentQuote } : {}), ...echo } satisfies LnurlPayCallbackResponse);
    }
  } catch (err) {
    throw new LnurlError(err instanceof Error ? err.message : "Failed to get invoice");
  }
}

// Create a solver-mediated receive swap for an offline receiver and return the hold
// invoice + a LUD-21 verify URL. The preimage is held in the store (unrevealed until
// the settlement poller flips it) keyed by the swap's payment hash. It is safe at
// rest because the covenant's `enforcePayTo` pins the claim to the user's address —
// learning the preimage cannot redirect funds.
export async function createOfflineSwapAndRespond(args: {
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
  res: express.Response;
  logger: Logger;
  requestId: string;
}): Promise<void> {
  const { creator, store, offlineSwaps, baseUrl, amountMsat, receiveAddress, claimPublicKey, addressId, paymentQuote, echoLightningOption, res, logger, requestId } = args;
  try {
    // Caller guarantees whole satoshis (rejected at the route otherwise).
    const swap = await creator.create({ amountSat: amountMsat / 1000, receiveAddress, claimPublicKey });
    const accepted = { paymentHash: swap.preimageHash, pr: swap.invoice, sessionId: `offline:${addressId}`, preimage: swap.preimage, amountMsat, addressId };
    // With DB_PATH, OfflineSwapStore is the single atomic persistence boundary:
    // it writes both settlement and restart recovery rows in one transaction.
    if (offlineSwaps) offlineSwaps.createAccepted({ ...accepted, recovery: swap.recovery });
    else store.create({ ...accepted, swapId: swap.swapId });
    res.json({
      pr: swap.invoice,
      routes: [],
      verify: `${baseUrl}/lnurl/verify/${swap.preimageHash}`,
      verifyBatch: `${baseUrl}${BATCH_PATH}`,
      ...(paymentQuote ? { paymentQuote } : {}),
      ...(echoLightningOption ? { paymentOption: "lightning" } : {}),
    } satisfies LnurlPayCallbackResponse);
  } catch (err) {
    logger.warn("offline_quote_failed", { requestId, error: err });
    const reason = err instanceof RailRefusedError ? err.message : "Unable to create offline invoice";
    throw new LnurlError(reason);
  }
}
