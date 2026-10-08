import { describe, it, expect } from "vitest";
import { baseUnits, ffPaymentQuote } from "../src/rails/fixedfloat/quote.js";
import type { FfOrder } from "../src/rails/fixedfloat/client.js";
import type { FfRail } from "../src/rails/fixedfloat/rates.js";

const RAIL: FfRail = {
  optionId: "ff-usdtarbitrum", ffCode: "USDTARBITRUM", asset: "eip155:42161/erc20:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9",
  unit: "USDT", decimals: 6, minSat: 2_844, maxSat: 17_819_126,
};
const ORDER: FfOrder = {
  id: "AB12CD", token: "secret-order-token", type: "fixed", status: "NEW", expiresAt: 1_791_000_900,
  from: { code: "USDTARBITRUM", amount: "8.578", address: "0x" + "ab".repeat(20), tag: null, txid: null },
  to: { code: "BTCLN", amount: "0.00010000" },
  emergency: null,
};
const quote = (overrides: Partial<Parameters<typeof ffPaymentQuote>[0]> = {}) =>
  ffPaymentQuote({ amountMsat: 10_000_000, order: ORDER, rail: RAIL, toAmountSat: 9_980, payBy: 1_791_001_800, fromBtc: "0.00010268", ...overrides });

describe("baseUnits", () => {
  it('converts 8.578 USDT at 6 decimals to "8578000"', () => {
    expect(baseUnits("8.578", 6)).toBe("8578000");
  });

  it("converts a whole amount without a decimal point", () => {
    expect(baseUnits("12", 6)).toBe("12000000");
    expect(baseUnits("12.000000000", 6)).toBe("12000000");
  });

  it("returns undefined for an amount with more decimals than the token has", () => {
    expect(baseUnits("8.5781234", 6)).toBeUndefined();
    expect(baseUnits("1e-7", 6)).toBeUndefined();
    expect(baseUnits("0", 6)).toBeUndefined();
    expect(baseUnits("-1", 6)).toBeUndefined();
  });

  it("never uses floating point", () => {
    // 123456789012.123456 x 1e6 is past 2^53, where a Number drops the last digits.
    expect(baseUnits("123456789012.123456", 6)).toBe("123456789012123456");
    expect(baseUnits("0.000001", 18)).toBe("1000000000000");
  });
});

describe("ffPaymentQuote", () => {
  it("payment.unit equals the option's unit code", () => {
    expect(quote()?.payment).toEqual({ amount: "8578000", unit: "USDT" });
  });

  it("payment.amount is a string of digits with no leading zero", () => {
    const amount = quote({ order: { ...ORDER, from: { ...ORDER.from, amount: "0.578" } } })?.payment.amount;
    expect(amount).toBe("578000");
    expect(amount).toMatch(/^[1-9][0-9]*$/);
  });

  it("is refused rather than rounded when the deposit does not fit the token", () => {
    expect(quote({ order: { ...ORDER, from: { ...ORDER.from, amount: "8.5780001" } } })).toBeUndefined();
  });

  it("requested stays in msat and equals the callback amount", () => {
    expect(quote()?.requested).toEqual({ amount: "10000000", unit: "msat" });
  });

  it("receive reports the corridor's to_amount, below requested", () => {
    expect(quote()?.receive).toEqual({ amount: "9980000", unit: "msat" });
  });

  it("expiresAt is the earlier of the FF expiration and the invoice deadline", () => {
    expect(quote()?.expiresAt).toBe(new Date(1_791_000_900_000).toISOString());
    expect(quote({ payBy: 1_791_000_100 })?.expiresAt).toBe(new Date(1_791_000_100_000).toISOString());
  });

  it("fees name both the provider and the solver leg", () => {
    expect(quote()?.fees).toEqual([
      { name: "provider", amount: { amount: "268000", unit: "msat" } },
      { name: "solver", amount: { amount: "20000", unit: "msat" } },
    ]);
    expect(quote({ fromBtc: undefined })?.fees).toEqual([{ name: "solver", amount: { amount: "20000", unit: "msat" } }]);
  });

  it("carries FixedFloat's order id, never its token", () => {
    expect(quote()?.id).toBe("AB12CD");
    expect(JSON.stringify(quote())).not.toContain("secret-order-token");
  });
});
