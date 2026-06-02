import { describe, it, expect } from "vitest";
import { decodeInvoiceAmountMsat } from "../src/bolt11.js";

describe("decodeInvoiceAmountMsat", () => {
  it("decodes each multiplier to millisatoshis", () => {
    expect(decodeInvoiceAmountMsat("lnbc11filler")).toBe(100_000_000_000); // 1 BTC, no multiplier
    expect(decodeInvoiceAmountMsat("lnbc1m1filler")).toBe(100_000_000); // milli
    expect(decodeInvoiceAmountMsat("lnbc1u1filler")).toBe(100_000); // micro
    expect(decodeInvoiceAmountMsat("lnbc100n1filler")).toBe(10_000); // nano
    expect(decodeInvoiceAmountMsat("lnbc500n1filler")).toBe(50_000);
    expect(decodeInvoiceAmountMsat("lnbc10p1filler")).toBe(1); // pico, multiple of 10
  });

  it("handles testnet and regtest currency prefixes", () => {
    expect(decodeInvoiceAmountMsat("lntb100n1filler")).toBe(10_000);
    expect(decodeInvoiceAmountMsat("lnbcrt100n1filler")).toBe(10_000);
  });

  it("rejects pico amounts that are not a multiple of 10", () => {
    expect(decodeInvoiceAmountMsat("lnbc5p1filler")).toBeNull();
  });

  it("returns null for amountless invoices", () => {
    expect(decodeInvoiceAmountMsat("lnbc1filler")).toBeNull();
    expect(decodeInvoiceAmountMsat("lntb1filler")).toBeNull();
  });

  it("returns null for garbage / non-invoices", () => {
    expect(decodeInvoiceAmountMsat("garbage")).toBeNull();
    expect(decodeInvoiceAmountMsat("")).toBeNull();
    expect(decodeInvoiceAmountMsat("lnbc1payme")).toBeNull(); // amountless ("lnbc" HRP)
  });
});
