import { LnurlError } from "./errors.js";
import { isTokenAddress, type TokenAsset, type TokenOption } from "./token-options.js";
import type { DestinationResult } from "./types.js";
import { formatUnitAmount } from "./units.js";

export interface TokenQuote {
  optionId: string;
  destination: string;
  baseUnits: string;
  amount: string;
  value: string;
  /** Quote deadline in Unix milliseconds. */
  expiresAt: number;
  paymentDestinationTag?: string;
}

interface QuotedPayment {
  destination: string;
  baseUnits: string;
  amount: string;
  paymentDestinationTag?: string;
}

const decimal = (value: string): string => value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");

function tokenPayment(token: TokenOption, answer: DestinationResult): QuotedPayment {
  if (answer.paymentOption !== token.id) throw new LnurlError(`The callback answered for ${answer.paymentOption}, not ${token.id}`);
  const destination = answer.paymentDestination;
  if (!destination || !isTokenAddress(token.asset.namespace, destination)) {
    throw new LnurlError(`The callback returned no ${token.asset.namespace} address to pay`);
  }
  const payment = answer.paymentQuote?.payment as { amount?: unknown; unit?: unknown } | undefined;
  const whole = typeof payment?.amount === "string" && /^[0-9]{1,78}$/.test(payment.amount) && /[1-9]/.test(payment.amount);
  if (!whole || typeof payment?.unit !== "string" || payment.unit.toUpperCase() !== token.unit.code) {
    throw new LnurlError(`The callback quoted no whole amount of ${token.unit.code}`);
  }
  if (!Number.isInteger(token.unit.decimals) || token.unit.decimals < 0 || token.unit.decimals > 36) {
    throw new LnurlError("The token unit has invalid decimals");
  }
  const baseUnits = payment!.amount as string;
  return {
    destination, baseUnits, amount: decimal(formatUnitAmount(BigInt(baseUnits).toString(), token.unit.decimals)),
    ...(answer.paymentDestinationTag !== undefined ? { paymentDestinationTag: answer.paymentDestinationTag } : {}),
  };
}

function paysQuote(uri: string, { destination, baseUnits, amount, paymentDestinationTag }: QuotedPayment, asset: TokenAsset): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  const q = url.searchParams;
  // Ambiguous fields can make wallets pay different transfers from the same URI.
  const only = (key: string): string | undefined => q.getAll(key).length === 1 ? q.get(key)! : undefined;
  if (asset.namespace === "eip155" && url.protocol === "ethereum:") {
    const target = /^(0x[0-9a-f]{40})(?:@(\d+))?\/transfer$/i.exec(url.pathname);
    return paymentDestinationTag === undefined && target !== null && [...q.keys()].every((key) => key === "address" || key === "uint256") &&
      target[1]!.toLowerCase() === asset.reference.toLowerCase() &&
      (target[2] ?? "1") === asset.chainReference &&
      only("address")?.toLowerCase() === destination.toLowerCase() && only("uint256") === baseUnits;
  }
  if (asset.namespace === "solana" && url.protocol === "solana:") {
    const requestedAmount = only("amount");
    return url.pathname === destination && only("spl-token") === asset.reference &&
      q.getAll("memo").length <= 1 && (paymentDestinationTag === undefined || only("memo") === paymentDestinationTag) &&
      requestedAmount !== undefined && /^\d+(?:\.\d+)?$/.test(requestedAmount) && decimal(requestedAmount) === amount;
  }
  return false;
}

/** Validates the token answer and keeps only an instruction that pays its exact quote. */
export function payableTokenUri(token: TokenOption, answer: DestinationResult): string {
  const payment = tokenPayment(token, answer);
  return answer.paymentURI && paysQuote(answer.paymentURI, payment, token.asset) ? answer.paymentURI : payment.destination;
}

/** Normalizes an expiring token quote without applying a wallet's minimum lifetime or price policy. */
export function normalizeTokenQuote(token: TokenOption, answer: DestinationResult, nowMs = Date.now()): TokenQuote {
  const payment = tokenPayment(token, answer);
  const rawExpiry = answer.paymentQuote?.expiresAt;
  const expiresAt = typeof rawExpiry === "string" ? Date.parse(rawExpiry) : NaN;
  if (!Number.isFinite(nowMs) || !Number.isFinite(expiresAt) || expiresAt <= nowMs) {
    throw new LnurlError("The token quote has no valid future expiry");
  }
  return {
    optionId: token.id, ...payment,
    value: answer.paymentURI && paysQuote(answer.paymentURI, payment, token.asset) ? answer.paymentURI : payment.destination,
    expiresAt,
  };
}
