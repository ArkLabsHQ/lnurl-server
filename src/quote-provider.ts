// LUD-XX paymentQuote: quote payments in units other than millisatoshis (USD, USDT, ...).
// This server has no rate oracle, so quoting is delegated to an injected QuoteProvider;
// without one, `units` is not advertised and any unit-denominated request is rejected.
// Real rate sourcing, assets, and swap-backed quotes live behind this interface.

/** An advertised denomination unit. Amounts are integers in the unit's smallest unit. */
export interface Unit {
  code: string;
  decimals: number;
  name?: string;
  symbol?: string;
  assetId?: string;
  minAmount?: string;
  maxAmount?: string;
}

/** An amount denominated in a unit. Strings avoid JSON integer-precision loss. `msat` = millisats. */
export interface AmountObject {
  amount: string;
  unit: string;
}

export interface FeeObject {
  amount: string;
  unit: string;
  description?: string;
}

/** The quote echoed back to the wallet (LUD-XX). */
export interface PaymentQuote {
  id?: string;
  expiresAt?: string;
  requested: AmountObject;
  payment: AmountObject;
  receive?: AmountObject;
  fees?: FeeObject[];
}

export interface QuoteRequest {
  /** Raw callback `amount` — an integer in the smallest unit of `unit` (or msat when unit is absent). */
  amount: number;
  unit?: string;
  receiveUnit?: string;
  paymentOption?: string;
}

/** Thrown by a provider for an unsupported / out-of-range / malformed unit. */
export class QuoteError extends Error {}

export interface QuoteProvider {
  /** Units advertised in the payRequest. `paymentOption` scopes per-option units when supported. */
  units(paymentOption?: string): Unit[];
  /** Quote a unit-denominated request. Throws {@link QuoteError} on a bad unit. */
  quote(req: QuoteRequest): PaymentQuote;
}

export type ApplyQuoteResult =
  | { ok: true; amountMsat: number; paymentQuote: PaymentQuote }
  | { ok: false; reason: string };

/** Apply a quote for a unit-denominated callback: returns the effective msat amount to
 *  charge downstream + the paymentQuote to echo, or an error reason. The Lightning path
 *  requires the quoted `payment` to be denominated in `msat`. */
export function applyQuote(provider: QuoteProvider | undefined, req: QuoteRequest): ApplyQuoteResult {
  if (!provider) return { ok: false, reason: "Unsupported unit" };
  // The advertised unit's own bounds, when it carries them — checked before quoting.
  if (req.unit !== undefined && Number.isInteger(req.amount)) {
    const u = provider.units(req.paymentOption).find((x) => x.code === req.unit);
    if (u) {
      const amount = BigInt(req.amount);
      if (u.minAmount !== undefined && amount < BigInt(u.minAmount)) return { ok: false, reason: `Amount below ${req.unit} minimum (${u.minAmount})` };
      if (u.maxAmount !== undefined && amount > BigInt(u.maxAmount)) return { ok: false, reason: `Amount above ${req.unit} maximum (${u.maxAmount})` };
    }
  }
  let q: PaymentQuote;
  try {
    q = provider.quote(req);
  } catch (e) {
    if (e instanceof QuoteError) return { ok: false, reason: e.message };
    // A provider BUG is not a payer-facing "unsupported unit" — log it and say so.
    console.error("quote provider threw", e);
    return { ok: false, reason: "Quote failed" };
  }
  if (q.payment.unit !== "msat") {
    return { ok: false, reason: "Quote payment must be denominated in msat" };
  }
  // The wire carries amounts as strings precisely to avoid float precision loss —
  // parse via BigInt and refuse what JS numbers can't hold exactly.
  let amountBig: bigint;
  try {
    amountBig = BigInt(q.payment.amount);
  } catch {
    return { ok: false, reason: "Invalid quoted amount" };
  }
  if (amountBig > BigInt(Number.MAX_SAFE_INTEGER) || amountBig <= 0n) {
    return { ok: false, reason: "Invalid quoted amount" };
  }
  const amountMsat = Number(amountBig);
  return { ok: true, amountMsat, paymentQuote: q };
}
