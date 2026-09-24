import { lnurlFetch, type FetchImpl } from "./http.js";
import { LnurlError, LnurlTimeoutError, LnurlTransportError } from "./errors.js";
import { toPayRequestUrl } from "./encoding.js";
import type { Bolt11Result, InvoiceResult, PayRequest, PaymentQuote, PollVerifyOptions, RequestInvoiceOptions, VerifyStatus } from "./types.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { amountMsatOf, paymentHashOf } from "./bolt11.js";

function preimageOpens(preimage: string, pr: string): boolean {
  const hash = paymentHashOf(pr);
  if (!hash || !/^[0-9a-f]{64}$/i.test(preimage)) return false;
  return hex.encode(sha256(hex.decode(preimage.toLowerCase()))) === hash;
}

/**
 * Fetches the payRequest for a lightning address or bech32 LNURL.
 *
 * The returned payRequest carries its `source` (URL plus `address`/`session`
 * surface) so `requestInvoice` can key its rail guards off it. Anything whose
 * `tag` is not `payRequest` is rejected: this client only pays.
 *
 * @param input - A lightning address or bech32 LNURL.
 * @param fetchImpl - The injected `fetch` implementation to call.
 * @returns The payRequest with its fetch source attached.
 */
export async function resolve(input: string, fetchImpl: FetchImpl): Promise<PayRequest> {
  const source = toPayRequestUrl(input);
  const body = await lnurlFetch<PayRequest>(source.url, undefined, fetchImpl);
  if (body.tag !== "payRequest") throw new LnurlError(`Expected a payRequest, got "${String(body.tag)}"`);
  return { ...body, source };
}

/**
 * Asks the payRequest callback for an invoice or payment destination.
 *
 * `amountSat` is sats and is converted to millisats on the wire; it is
 * range-checked locally against the payRequest bounds before any network
 * call. `paymentOption` and `unit` apply only to an address payRequest and
 * are rejected on a session one, because the session callback reads `amount`
 * and `comment` only and the server would silently ignore the rail choice.
 * `verify` on the result is optional: the server omits it when the BOLT11
 * payment hash will not decode.
 *
 * @param payRequest - The payRequest from `resolve`, with its source attached.
 * @param opts - `amountSat` plus optional comment, rail and unit selection.
 * @param fetchImpl - The injected `fetch` implementation to call.
 * @returns A BOLT11 invoice or a destination to pay on the selected rail.
 */
export async function requestInvoice(
  payRequest: PayRequest,
  opts: RequestInvoiceOptions,
  fetchImpl: FetchImpl,
): Promise<InvoiceResult> {
  if (payRequest.source.surface === "session" && (opts.paymentOption !== undefined || opts.unit !== undefined)) {
    throw new LnurlError("paymentOption and unit are only supported on address payRequests, not on a session payRequest");
  }
  const amountMsat = opts.amountSat * 1000;
  // The top-level pair describes the rail a payer gets by sending no option, so
  // a selected option that publishes its own bounds overrides it — checking
  // against the top-level pair would reject amounts that option accepts.
  const selected = opts.paymentOption
    ? payRequest.paymentOptions?.find((option) => option.id === opts.paymentOption)
    : undefined;
  const min = selected?.minSendable ?? payRequest.minSendable;
  const max = selected?.maxSendable ?? payRequest.maxSendable;
  if (!Number.isSafeInteger(amountMsat)) {
    throw new LnurlError("Amount must be a whole number of millisats");
  }
  if (amountMsat < min || amountMsat > max) {
    throw new LnurlError(`Amount must be between ${min} and ${max} millisats`);
  }
  // Checked locally for the same reason the amount is: the server would reject
  // it anyway, but a round trip later and with a less specific message. LUD-12
  // treats an absent or zero commentAllowed as "comments not supported".
  if (opts.comment !== undefined && opts.comment.length > 0) {
    const allowed = payRequest.commentAllowed ?? 0;
    if (allowed === 0) throw new LnurlError("This payRequest does not accept comments");
    if (opts.comment.length > allowed) {
      throw new LnurlError(`Comment must be at most ${allowed} characters`);
    }
  }
  const params = new URLSearchParams();
  params.set("amount", String(amountMsat));
  // Non-empty only, matching the guard above: an empty comment is vacuous and
  // sending `comment=` to a payRequest that accepts none is a needless
  // protocol violation the guard would otherwise have caught.
  if (opts.comment) params.set("comment", opts.comment);
  if (opts.paymentOption !== undefined) params.set("paymentOption", opts.paymentOption);
  if (opts.unit !== undefined) params.set("unit", opts.unit);
  const sep = payRequest.callback.includes("?") ? "&" : "?";
  const body = await lnurlFetch<Record<string, unknown>>(`${payRequest.callback}${sep}${params.toString()}`, undefined, fetchImpl);
  if (typeof body.pr === "string") {
    const invoiceMsat = amountMsatOf(body.pr);
    if (invoiceMsat === undefined) throw new LnurlError("The callback returned an invoice that does not decode");
    // An amountless invoice answering an amounted request is refused too: the
    // payer asked for a fixed amount, and paying it could settle for any amount.
    if (invoiceMsat !== amountMsat) {
      throw new LnurlError(`The callback returned an invoice for ${invoiceMsat ?? "no"} millisats, not the requested ${amountMsat}`);
    }
    const result: Bolt11Result = { kind: "bolt11", pr: body.pr, verify: typeof body.verify === "string" ? body.verify : undefined };
    if (typeof body.verifyBatch === "string") result.verifyBatch = body.verifyBatch;
    if (typeof body.paymentOption === "string") result.paymentOption = body.paymentOption;
    if (body.paymentQuote !== undefined) result.paymentQuote = body.paymentQuote as PaymentQuote;
    return result;
  }
  if (typeof body.paymentOption === "string") {
    return {
      kind: "destination",
      paymentOption: body.paymentOption,
      ...(typeof body.paymentDestination === "string" ? { paymentDestination: body.paymentDestination } : {}),
      ...(typeof body.verify === "string" ? { verify: body.verify } : {}),
      ...(typeof body.verifyBatch === "string" ? { verifyBatch: body.verifyBatch } : {}),
    };
  }
  throw new LnurlError("Unexpected callback response");
}

/** Parses one verify answer — the per-invoice route, one `results` entry of the
 *  batch endpoint, or one streamed frame payload all share the shape. */
export function parseVerifyStatus(body: Record<string, unknown>): VerifyStatus {
  if (typeof body.pr === "string") {
    const settled = body.settled === true;
    const preimage = typeof body.preimage === "string" ? body.preimage : null;
    // A settled claim is only proof when the preimage opens this invoice; one
    // that cannot be checked is treated like one that fails.
    if (settled && (!preimage || !preimageOpens(preimage, body.pr))) {
      throw new LnurlError("Verify reported settled with a preimage that does not match the invoice's payment hash");
    }
    return { kind: "bolt11", settled, preimage, pr: body.pr };
  }
  // Without this the cast would hand back `undefined` typed as `string` for any
  // body that is neither a bolt11 nor a well-formed destination.
  if (typeof body.paymentOption !== "string") {
    throw new LnurlTransportError("Verify response is neither a bolt11 nor a destination status");
  }
  return {
    kind: "destination",
    settled: body.settled === true,
    paymentOption: body.paymentOption,
    ...(typeof body.paymentDestination === "string" ? { paymentDestination: body.paymentDestination } : {}),
    ...(typeof body.paymentReference === "string" ? { paymentReference: body.paymentReference } : {}),
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new LnurlError("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new LnurlError("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Polls a verify URL until the payment settles, the deadline passes, or the
 * caller aborts.
 *
 * `verify` is optional on a callback response (the server omits it when the
 * BOLT11 payment hash will not decode), so there is no polling without a URL
 * and an empty one is rejected. A `{ status: "ERROR" }` body at HTTP 200 is
 * terminal, not a retry: unknown payment hashes report `Not found` that way.
 * Every snapshot, settled or not, goes to `onUpdate`; an overrun throws
 * `LnurlTimeoutError` with the last snapshot attached.
 *
 * @param verifyUrl - The verify URL from the invoice result.
 * @param opts - Optional interval, timeout, per-poll callback and abort signal.
 * @param fetchImpl - The injected `fetch` implementation to call.
 * @returns The settled verify status.
 */
export async function pollVerify(
  verifyUrl: string,
  opts: PollVerifyOptions | undefined,
  fetchImpl: FetchImpl,
): Promise<VerifyStatus> {
  if (!verifyUrl) throw new LnurlError("verify URL is required");
  const intervalMs = opts?.intervalMs ?? 1000;
  const timeoutMs = opts?.timeoutMs ?? 120000;
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot: VerifyStatus | undefined;
  for (;;) {
    if (opts?.signal?.aborted) throw opts.signal.reason ?? new LnurlError("Aborted");
    const body = await lnurlFetch<Record<string, unknown>>(verifyUrl, undefined, fetchImpl);
    const status = parseVerifyStatus(body);
    lastSnapshot = status;
    opts?.onUpdate?.(status);
    if (status.settled) return status;
    if (Date.now() >= deadline) throw new LnurlTimeoutError(`Verify timed out after ${timeoutMs}ms`, { lastSnapshot });
    await sleep(intervalMs, opts?.signal);
  }
}
