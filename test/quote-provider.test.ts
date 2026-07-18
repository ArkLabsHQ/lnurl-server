import { describe, it, expect } from "vitest";
import { applyQuote, QuoteError, type QuoteProvider, type PaymentQuote } from "../src/quote-provider.js";

// A fake fixed-rate provider: 1 USD (decimals 2) = 1000 msat per cent, i.e. amount(cents)*1000 msat.
const usd: QuoteProvider = {
  units: () => [{ code: "USD", decimals: 2 }],
  quote: (req): PaymentQuote => {
    if (req.unit !== "USD") throw new QuoteError("Unsupported unit");
    return {
      requested: { amount: String(req.amount), unit: "USD" },
      payment: { amount: String(req.amount * 1000), unit: "msat" },
    };
  },
};

describe("applyQuote", () => {
  it("errors with 'Unsupported unit' when no provider is configured", () => {
    expect(applyQuote(undefined, { amount: 100, unit: "USD" })).toEqual({ ok: false, reason: "Unsupported unit" });
  });

  it("returns the quoted msat amount + paymentQuote for a supported unit", () => {
    const r = applyQuote(usd, { amount: 100, unit: "USD" });
    expect(r).toMatchObject({ ok: true, amountMsat: 100000 });
    expect((r as { paymentQuote: PaymentQuote }).paymentQuote.requested).toEqual({ amount: "100", unit: "USD" });
  });

  it("surfaces a QuoteError reason from the provider", () => {
    expect(applyQuote(usd, { amount: 100, unit: "EUR" })).toEqual({ ok: false, reason: "Unsupported unit" });
  });

  it("rejects a quote whose payment is not denominated in msat", () => {
    const asset: QuoteProvider = {
      units: () => [{ code: "USDT", decimals: 6 }],
      quote: (req): PaymentQuote => ({
        requested: { amount: String(req.amount), unit: "USDT" },
        payment: { amount: String(req.amount), unit: "USDT" },
      }),
    };
    expect(applyQuote(asset, { amount: 100, unit: "USDT" })).toMatchObject({ ok: false });
  });
});
