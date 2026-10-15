import { lnurlFetch, type FetchImpl } from "./http.js";
import { LnurlError, LnurlTimeoutError, LnurlTransportError } from "./errors.js";
import { toPayRequestUrl } from "./encoding.js";
import type { Bolt11Result, DestinationResult, InvoiceResult, PayRequest, PaymentQuote, PollVerifyOptions, RequestInvoiceOptions, Unit, VerifyExpectation, VerifyStatus } from "./types.js";
import { isTokenAddress, tokenOptions, type TokenOption } from "./token-options.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { amountMsatOf, paymentHashOf } from "./bolt11.js";

function preimageOpens(preimage: string, pr: string): boolean {
  const hash = paymentHashOf(pr);
  if (!hash || !/^[0-9a-f]{64}$/i.test(preimage)) return false;
  return hex.encode(sha256(hex.decode(preimage.toLowerCase()))) === hash;
}

/** The checks the BTCPay plugin makes of a token answer (LnurlTokenRequester.cs): the
 *  option it asked for, an address on the token's own chain, and a whole amount of the token. */
function assertTokenAnswer(token: TokenOption, answer: DestinationResult): void {
  if (answer.paymentOption !== token.id) throw new LnurlError(`The callback answered for ${answer.paymentOption}, not ${token.id}`);
  if (!answer.paymentDestination || !isTokenAddress(token.asset.namespace, answer.paymentDestination)) {
    throw new LnurlError(`The callback returned no ${token.asset.namespace} address to pay`);
  }
  const payment = answer.paymentQuote?.payment as { amount?: unknown; unit?: unknown } | undefined;
  const whole = typeof payment?.amount === "string" && /^[0-9]{1,78}$/.test(payment.amount) && /[1-9]/.test(payment.amount);
  if (!whole || typeof payment?.unit !== "string" || payment.unit.toUpperCase() !== token.unit.code) {
    throw new LnurlError(`The callback quoted no whole amount of ${token.unit.code}`);
  }
}

/** The advertised unit `code` names, after the amount checks the receiver would make. */
function quotableUnit(payRequest: PayRequest, code: string, amount: number): Unit {
  const unit = payRequest.units?.find((u) => u.code.toUpperCase() === code.toUpperCase());
  if (!unit) throw new LnurlError(`This payRequest does not quote in ${code}`);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new LnurlError(`Amount must be a positive whole number of ${unit.code}'s smallest unit`);
  const bound = (b: string | undefined) => (b !== undefined && /^\d+$/.test(b) ? BigInt(b) : undefined);
  const lo = bound(unit.minAmount);
  const hi = bound(unit.maxAmount);
  if ((lo !== undefined && BigInt(amount) < lo) || (hi !== undefined && BigInt(amount) > hi)) {
    throw new LnurlError(`Amount must be between ${unit.minAmount ?? 1} and ${unit.maxAmount ?? "any"} in ${unit.code}'s smallest unit`);
  }
  return unit;
}

/** The millisats a quote says `amount` of `unit` costs, refusing a quote for anything else. */
function quotedMsat(raw: unknown, unit: string, amount: number): number {
  const q = raw as Partial<PaymentQuote> | undefined;
  if (q?.requested?.unit !== unit || q.requested.amount !== String(amount)) {
    throw new LnurlError(`The callback did not quote ${amount} ${unit}`);
  }
  const msat = q.payment?.unit === "msat" && /^\d+$/.test(q.payment.amount) ? Number(q.payment.amount) : NaN;
  if (!Number.isSafeInteger(msat) || msat <= 0) throw new LnurlError("The callback quoted no millisat amount to pay");
  return msat;
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
 * call. With `unit` and `amount` instead, the receiver quotes the amount to
 * millisats and the invoice must match that quote. `paymentOption` is rejected
 * on a session payRequest that does not advertise options: a live session's
 * callback would silently ignore it.
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
  if (payRequest.source.surface === "session" && opts.paymentOption !== undefined && !payRequest.paymentOptions) {
    throw new LnurlError("paymentOption needs a session payRequest that advertises options; this one does not");
  }
  const unit = opts.unit === undefined ? undefined : quotableUnit(payRequest, opts.unit, opts.amount);
  // The top-level pair describes the rail a payer gets by sending no option, so
  // a selected option that publishes its own bounds overrides it — checking
  // against the top-level pair would reject amounts that option accepts.
  const selected = opts.paymentOption
    ? payRequest.paymentOptions?.find((option) => option.id === opts.paymentOption)
    : undefined;
  const token = selected?.asset !== undefined ? tokenOptions(payRequest).find((o) => o.id === selected.id) : undefined;
  if (selected?.asset !== undefined && !token) throw new LnurlError(`paymentOption ${selected.id} is not a token this client can pay`);
  const min = selected?.minSendable ?? payRequest.minSendable;
  const max = selected?.maxSendable ?? payRequest.maxSendable;
  // A unit amount's millisats are the receiver's to quote, so only theirs can be checked.
  const amountMsat = unit ? undefined : opts.amountSat! * 1000;
  if (amountMsat !== undefined && !Number.isSafeInteger(amountMsat)) {
    throw new LnurlError("Amount must be a whole number of millisats");
  }
  if (amountMsat !== undefined && (amountMsat < min || amountMsat > max)) {
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
  params.set("amount", String(unit ? opts.amount : amountMsat));
  // Non-empty only, matching the guard above: an empty comment is vacuous and
  // sending `comment=` to a payRequest that accepts none is a needless
  // protocol violation the guard would otherwise have caught.
  if (opts.comment) params.set("comment", opts.comment);
  if (opts.paymentOption !== undefined) params.set("paymentOption", opts.paymentOption);
  if (unit) params.set("unit", unit.code);
  const sep = payRequest.callback.includes("?") ? "&" : "?";
  const body = await lnurlFetch<Record<string, unknown>>(`${payRequest.callback}${sep}${params.toString()}`, undefined, fetchImpl);
  if (typeof body.pr === "string") {
    if (token) throw new LnurlError(`The callback answered token option ${token.id} with an invoice`);
    const invoiceMsat = amountMsatOf(body.pr);
    if (invoiceMsat === undefined) throw new LnurlError("The callback returned an invoice that does not decode");
    const expectedMsat = unit ? quotedMsat(body.paymentQuote, unit.code, opts.amount!) : amountMsat;
    // An amountless invoice answering an amounted request is refused too: the
    // payer asked for a fixed amount, and paying it could settle for any amount.
    if (invoiceMsat !== expectedMsat) {
      throw new LnurlError(`The callback returned an invoice for ${invoiceMsat ?? "no"} millisats, not the ${unit ? "quoted" : "requested"} ${expectedMsat}`);
    }
    const result: Bolt11Result = { kind: "bolt11", pr: body.pr, verify: typeof body.verify === "string" ? body.verify : undefined };
    if (typeof body.verifyBatch === "string") result.verifyBatch = body.verifyBatch;
    if (typeof body.paymentOption === "string") result.paymentOption = body.paymentOption;
    if (body.paymentQuote !== undefined) result.paymentQuote = body.paymentQuote as PaymentQuote;
    return result;
  }
  if (typeof body.paymentOption === "string") {
    const result: DestinationResult = {
      kind: "destination",
      paymentOption: body.paymentOption,
      ...(typeof body.paymentDestination === "string" ? { paymentDestination: body.paymentDestination } : {}),
      ...(typeof body.paymentDestinationTag === "string" ? { paymentDestinationTag: body.paymentDestinationTag } : {}),
      ...(typeof body.paymentURI === "string" ? { paymentURI: body.paymentURI } : {}),
      ...(body.paymentQuote && typeof body.paymentQuote === "object" ? { paymentQuote: body.paymentQuote as PaymentQuote } : {}),
      ...(typeof body.expiresAt === "number" ? { expiresAt: body.expiresAt } : {}),
      ...(typeof body.provider === "string" ? { provider: body.provider } : {}),
      ...(typeof body.verify === "string" ? { verify: body.verify } : {}),
      ...(typeof body.verifyBatch === "string" ? { verifyBatch: body.verifyBatch } : {}),
    };
    if (token) assertTokenAnswer(token, result);
    // Only the check: a destination carries no amount of its own, so the caller pays the quote's.
    if (unit) quotedMsat(body.paymentQuote, unit.code, opts.amount!);
    return result;
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

/**
 * Whether a verify answer is about `expected`: a BOLT11 status for the same payment
 * hash, or a destination status on the same rail and, when both name one, the same
 * destination. The preimage check alone only proves the answer's own invoice.
 */
export function verifyStatusIsFor(status: VerifyStatus, expected: VerifyExpectation): boolean {
  if ("pr" in expected) {
    const hash = paymentHashOf(expected.pr);
    return status.kind === "bolt11" && hash !== null && paymentHashOf(status.pr) === hash;
  }
  return status.kind === "destination" && status.paymentOption === expected.paymentOption &&
    (status.paymentDestination === undefined || expected.paymentDestination === undefined || status.paymentDestination === expected.paymentDestination);
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
    if (opts?.expect && !verifyStatusIsFor(status, opts.expect)) throw new LnurlError("Verify answered about a different payment");
    lastSnapshot = status;
    opts?.onUpdate?.(status);
    if (status.settled) return status;
    if (Date.now() >= deadline) throw new LnurlTimeoutError(`Verify timed out after ${timeoutMs}ms`, { lastSnapshot });
    await sleep(intervalMs, opts?.signal);
  }
}
