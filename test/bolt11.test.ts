import { describe, it, expect } from "vitest";
import { bech32 } from "@scure/base";
import { createHash } from "node:crypto";
import { invoiceFactsFromBolt11, paymentHashFromBolt11 } from "../src/bolt11.js";
import { buildInvoice } from "./helpers/bolt11.js";

describe("paymentHashFromBolt11", () => {
  it("extracts the payment hash, skipping earlier fields", () => {
    const hash = createHash("sha256").update(Buffer.from("ab".repeat(32), "hex")).digest("hex");
    expect(paymentHashFromBolt11(buildInvoice(hash))).toBe(hash);
  });

  it("returns null for non-bech32 / bad-checksum input", () => {
    expect(paymentHashFromBolt11("lnbc1test")).toBeNull();
    expect(paymentHashFromBolt11("lnbc500n1fakeinvoice")).toBeNull();
    expect(paymentHashFromBolt11("")).toBeNull();
  });
});

describe("invoiceFactsFromBolt11", () => {
  const hash = "9a".repeat(32);

  it("decodes payment hash, u-denominated amount, and timestamp+expiry", () => {
    const now = 1_700_000_000;
    const facts = invoiceFactsFromBolt11(buildInvoice(hash, { amountHrp: "50u", timestamp: now, expirySeconds: 7200 }));
    expect(facts).toMatchObject({ paymentHash: hash, amountSats: 5000, expiresAt: now + 7200 });
  });

  it("decodes whole-bitcoin and pico denominations, rounding p down", () => {
    expect(invoiceFactsFromBolt11(buildInvoice(hash, { amountHrp: "1" })).amountSats).toBe(100_000_000);
    expect(invoiceFactsFromBolt11(buildInvoice(hash, { amountHrp: "500000p" })).amountSats).toBe(50);
    expect(invoiceFactsFromBolt11(buildInvoice(hash, { amountHrp: "15p" })).amountSats).toBe(0);
  });

  it("decodes amountless invoices to amountSats 0 and defaults expiry to 3600s", () => {
    const facts = invoiceFactsFromBolt11(buildInvoice(hash, { timestamp: 1_700_000_000 }));
    expect(facts.amountSats).toBe(0);
    expect(facts.expiresAt).toBe(1_700_000_000 + 3600);
  });

  it("throws on undecodable input and on a missing payment hash", () => {
    expect(() => invoiceFactsFromBolt11("lnbc1test")).toThrow();
    const words: number[] = [];
    for (let i = 0; i < 7; i++) words.push(0);
    for (let i = 0; i < 104; i++) words.push(0);
    expect(() => invoiceFactsFromBolt11(bech32.encode("lnbc", words, 2000))).toThrow(/payment hash/);
  });
});
