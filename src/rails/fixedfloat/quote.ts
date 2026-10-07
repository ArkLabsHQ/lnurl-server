// The LUD-XX paymentQuote for a FixedFloat order. Built here rather than by applyQuote,
// which only quotes a payment denominated in msat; this one is denominated in the token.

import type { PaymentQuote } from "../../quote-provider.js";
import type { FfOrder } from "./client.js";
import type { FfRail } from "./rates.js";

/** Base units as an integer string, or undefined when the amount does not fit the token's
 *  decimals. Refusing beats rounding: either direction lands the payer in FixedFloat's
 *  LESS/MORE emergency flow. Strings throughout, never a float. */
export function baseUnits(amount: string, decimals: number): string | undefined {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!match) return undefined;
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  if (fraction.length > decimals) return undefined;
  const digits = (match[1]! + fraction.padEnd(decimals, "0")).replace(/^0+/, "");
  return digits.length > 0 ? digits : undefined;
}

export function ffPaymentQuote(input: {
  amountMsat: number;
  order: FfOrder;
  rail: FfRail;
  /** What the corridor pays the receiver, after the solver's fee. */
  toAmountSat: number;
  /** Unix seconds: the corridor invoice's pay deadline. */
  invoiceExpiresAt: number;
  /** FixedFloat's own BTC valuation of the deposit, from `price`. */
  fromBtc?: string;
}): PaymentQuote | undefined {
  const { amountMsat, order, rail, toAmountSat, invoiceExpiresAt, fromBtc } = input;
  const payment = baseUnits(order.from.amount, rail.decimals);
  if (!payment || order.expiresAt === undefined) return undefined;
  const amountSat = amountMsat / 1000;
  const msat = (sats: number) => ({ amount: String(sats * 1000), unit: "msat" });
  // An estimate: the spread is inside FixedFloat's rate, so this is its valuation of the
  // deposit less what it delivers.
  const providerSat = fromBtc === undefined ? undefined : Math.round(Number(fromBtc) * 1e8) - amountSat;
  return {
    id: order.id,
    expiresAt: new Date(Math.min(order.expiresAt, invoiceExpiresAt) * 1000).toISOString(),
    requested: { amount: String(amountMsat), unit: "msat" },
    payment: { amount: payment, unit: rail.unit },
    receive: msat(toAmountSat),
    fees: [
      ...(providerSat !== undefined && Number.isSafeInteger(providerSat) && providerSat >= 0 ? [{ name: "provider", amount: msat(providerSat) }] : []),
      { name: "solver", amount: msat(amountSat - toAmountSat) },
    ],
  };
}
