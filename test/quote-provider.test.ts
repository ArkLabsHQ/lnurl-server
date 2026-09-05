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

  it("rejects quoted amounts beyond Number's safe integer range (no float precision loss)", () => {
    const huge: QuoteProvider = {
      units: () => [{ code: "USD", decimals: 2 }],
      quote: () => ({ requested: { amount: "1", unit: "USD" }, payment: { amount: "9007199254740993", unit: "msat" } }),
    };
    expect(applyQuote(huge, { amount: 1, unit: "USD" })).toMatchObject({ ok: false, reason: "Invalid quoted amount" });
  });

  it("collapses a non-QuoteError provider crash to a distinct 'Quote failed' (not 'Unsupported unit')", () => {
    const buggy: QuoteProvider = {
      units: () => [],
      quote: () => {
        throw new TypeError("oops");
      },
    };
    expect(applyQuote(buggy, { amount: 100, unit: "USD" })).toEqual({ ok: false, reason: "Quote failed" });
  });

  it("enforces the advertised unit's own min/max bounds before quoting", () => {
    const bounded: QuoteProvider = {
      units: () => [{ code: "USD", decimals: 2, minAmount: "10", maxAmount: "1000" }],
      quote: usd.quote,
    };
    expect(applyQuote(bounded, { amount: 5, unit: "USD" })).toMatchObject({ ok: false, reason: expect.stringMatching(/minimum/) });
    expect(applyQuote(bounded, { amount: 5000, unit: "USD" })).toMatchObject({ ok: false, reason: expect.stringMatching(/maximum/) });
    expect(applyQuote(bounded, { amount: 100, unit: "USD" })).toMatchObject({ ok: true, amountMsat: 100000 });
  });
});
