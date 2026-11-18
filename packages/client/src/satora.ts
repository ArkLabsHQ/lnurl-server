import { bech32m } from "@scure/base";
import { LnurlError } from "./errors.js";
import type { InvoiceResult } from "./types.js";

/** Returns the hosted checkout URL bound to the callback's Arkade address and requested sats. */
export function satoraPaymentUrl(answer: InvoiceResult, amountSat: number): string {
  if (answer.kind !== "destination" || answer.paymentOption !== "satora" || !answer.paymentURI || !answer.paymentDestination) {
    throw new LnurlError("The callback returned no Satora checkout");
  }

  const address = bech32m.decodeUnsafe(answer.paymentDestination, 120);
  if (address?.prefix === "ark" && address.words.length === 104 && Number.isSafeInteger(amountSat) && amountSat > 0) {
    try {
      const url = new URL(answer.paymentURI);
      const params = url.searchParams;
      if (url.origin === "https://app.satora.io" && url.pathname === "/polygon:USDC/arkade:BTC" &&
        !url.username && !url.password && !url.hash && params.size === 2 &&
        params.get("address") === answer.paymentDestination && params.get("targetAmount") === String(amountSat)) {
        return url.href;
      }
    } catch {
      // An invalid URL is an invalid checkout.
    }
  }
  throw new LnurlError("The Satora checkout does not match the requested Arkade payment");
}
