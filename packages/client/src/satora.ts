import { bech32m } from "@scure/base";
import { LnurlError } from "./errors.js";
import type { InvoiceResult } from "./types.js";

export interface SatoraPaymentTarget {
  destination: string;
  amountSat: number;
  verify: string;
  verifyBatch?: string;
  expiresAt?: number;
}

function verificationUrl(value: string | undefined): string {
  try {
    const url = new URL(value ?? "");
    const loopback = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol === "https:" || loopback) && !url.username && !url.password && !url.hash) return url.href;
  } catch {
    // Invalid verification URLs must fail before the payer can deposit funds.
  }
  throw new LnurlError("The callback returned an invalid Satora verification URL");
}

/** Reads the Arkade payout target for a payer-side Satora swap. */
export function satoraPaymentTarget(answer: InvoiceResult, amountSat: number): SatoraPaymentTarget {
  if (answer.kind !== "destination" || answer.paymentOption !== "satora" || !answer.paymentDestination) {
    throw new LnurlError("The callback returned no Satora payment target");
  }
  const address = bech32m.decodeUnsafe(answer.paymentDestination, 120);
  if (address?.prefix !== "ark" || address.words.length !== 104 || bech32m.fromWordsUnsafe(address.words)?.[0] !== 0) {
    throw new LnurlError("The callback returned an invalid mainnet Arkade destination");
  }
  if (!Number.isSafeInteger(amountSat) || amountSat <= 0 || !Number.isSafeInteger(amountSat * 1000)) {
    throw new LnurlError("A Satora payment requires a positive whole number of satoshis");
  }
  if (answer.expiresAt !== undefined && (!Number.isSafeInteger(answer.expiresAt) || answer.expiresAt <= 0)) {
    throw new LnurlError("The callback returned an invalid Satora expiry");
  }
  return {
    destination: answer.paymentDestination,
    amountSat,
    verify: verificationUrl(answer.verify),
    ...(answer.verifyBatch === undefined ? {} : { verifyBatch: verificationUrl(answer.verifyBatch) }),
    ...(answer.expiresAt === undefined ? {} : { expiresAt: answer.expiresAt }),
  };
}
