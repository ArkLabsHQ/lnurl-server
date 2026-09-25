import type { PaymentOption } from "../payment-options.js";
import type { Unit, PaymentQuote } from "../quote-provider.js";

/** LNURL-pay first-call response (LUD-06) */
export interface LnurlPayMetadata {
  callback: string;
  minSendable: number;
  maxSendable: number;
  metadata: string;
  tag: "payRequest";
  commentAllowed?: number;
  /** LUD-XX: advertised payment rails. Omitted when only lightning is offered. */
  paymentOptions?: PaymentOption[];
  /** LUD-XX: advertised denomination units. Omitted when no quote provider is configured. */
  units?: Unit[];
}

/** LNURL-pay callback response (BOLT11 / lightning) */
export interface LnurlPayCallbackResponse {
  pr: string;
  routes: never[];
  /** LUD-21: URL the payer can poll to confirm settlement. Omitted if the bolt11 can't be decoded. */
  verify?: string;
  /** LUD-XX verifyBatch: present exactly when `verify` is, since it only answers verify URLs. */
  verifyBatch?: string;
  /** LUD-XX: echoed when the wallet explicitly selected `paymentOption=lightning` on the callback. */
  paymentOption?: string;
  /** LUD-XX: the quote, when the request was unit-denominated. */
  paymentQuote?: PaymentQuote;
}

/** LUD-XX callback response for a non-`pr` payment option (e.g. a direct Arkade destination). */
export interface LnurlPayDestinationResponse {
  status: "OK";
  paymentOption: string;
  paymentDestination?: string;
  verify?: string;
  /** LUD-XX verifyBatch: batch/stream endpoint covering every verify URL this server issues. */
  verifyBatch?: string;
  /**
   * Unix seconds after which this server stops attributing payments to this
   * quote. A BOLT11 carries its own expiry and an address carries none, so
   * without this the payer cannot know one exists.
   *
   * It is not a deadline on the money: past it a payment still reaches the
   * destination, and on the covenant rail the sweeper still moves it. What
   * lapses is this server's record of it — `verify` stops answering and the
   * payment leaves no trace in the address's history.
   *
   * Absent on rails nothing here watches, where there is no such window.
   */
  expiresAt?: number;
  /** LUD-XX `paymentURI`: the wallet-executable instruction for this destination,
   *  carrying the requested amount, so the payer does not rebuild one from an
   *  address and a number the server already has. The spec requires a successful
   *  non-`pr` response to carry this or `paymentDestination`; we send both. */
  paymentURI?: string;
}

/** LNURL error response */
export interface LnurlErrorResponse {
  status: "ERROR";
  reason: string;
}
