// Vendored from @arkade-os/swap 0.1.0-rc.20 (packages/swap/src/rfq.ts, onchainHtlc.ts): defined there, not exported.
import { hex } from "@scure/base";
import type { RfqQuote } from "@arkade-os/swap/protocol";

const gateError = (reason: string, message: string): Error & { reason: string } => {
  const error = new Error(message) as Error & { reason: string };
  error.reason = reason;
  return error;
};

const quoteSats = (value: number | string, field: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`HTLC quote carries a non-sats ${field}: ${String(value)}`);
  }
  return value;
};

const assertFinite = (value: number | undefined, reason: string, label: string): void => {
  if (value !== undefined && !Number.isFinite(value)) {
    throw gateError(reason, `${label} is not a finite number (${String(value)})`);
  }
};

const MIN_CLAIM_WINDOW_SECONDS = 30 * 60;

export const newRfqId = (): string => hex.encode(crypto.getRandomValues(new Uint8Array(32)));

export const assertReceivable = (input: {
  quote: RfqQuote;
  payDeadline: number;
  now: number;
  minClaimWindowSeconds?: number;
  maxPayAmount?: number;
}): void => {
  assertFinite(input.payDeadline, "quote_malformed", "payDeadline");
  assertFinite(input.now, "invalid_gate_input", "now");
  assertFinite(input.minClaimWindowSeconds, "invalid_gate_input", "minClaimWindowSeconds");
  assertFinite(input.maxPayAmount, "invalid_gate_input", "maxPayAmount");
  const minClaimWindow = input.minClaimWindowSeconds ?? MIN_CLAIM_WINDOW_SECONDS;
  if (input.now >= input.payDeadline) {
    throw gateError("quote_expired", "quote or invoice already expired — request a fresh one");
  }
  if (input.quote.refund_locktime === undefined) {
    throw gateError("missing_refund_locktime", "receive quote carries no refund_locktime");
  }
  assertFinite(input.quote.refund_locktime, "quote_malformed", "quote refund_locktime");
  if (input.quote.refund_locktime - input.payDeadline < minClaimWindow) {
    throw gateError(
      "claim_window_too_short",
      `a payment at the deadline would leave under ${minClaimWindow}s to claim before the solver's refund opens`,
    );
  }
  if (input.maxPayAmount !== undefined && quoteSats(input.quote.from_amount, "from_amount") > input.maxPayAmount) {
    throw gateError(
      "price_too_high",
      `quote asks ${input.quote.from_amount} sats, above the ${input.maxPayAmount} ceiling`,
    );
  }
};
