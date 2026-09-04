import { describe, it, expect } from "vitest";
import { bech32 } from "@scure/base";
import { createHash } from "node:crypto";
import { invoiceFactsFromBolt11, paymentHashFromBolt11 } from "../src/bolt11.js";

/** Build a structurally-valid bolt11 whose payment-hash field is `paymentHashHex`.
 *  Layout: 35-bit timestamp, a decoy `d` field (type 13), an optional `x` expiry
 *  field (type 6), the `p` field (type 1, len 52), then 104 dummy signature words.
 *  The decoder must skip the decoy field to find the payment hash. Signature bytes
 *  are not valid — the decoder does not (and need not) verify them. */
function buildInvoice(paymentHashHex: string, opts: { amountHrp?: string; timestamp?: number; expirySeconds?: number } = {}): string {
  const words: number[] = [];
  const ts = opts.timestamp ?? 0;
  for (let i = 0; i < 7; i++) words.push(Math.floor(ts / 32 ** (6 - i)) % 32);
  const desc = bech32.toWords(new TextEncoder().encode("hello"));
  words.push(13, desc.length >> 5, desc.length & 31, ...desc);
  if (opts.expirySeconds !== undefined) {
    const ew: number[] = [];
    let x = opts.expirySeconds;
    do { ew.unshift(x % 32); x = Math.floor(x / 32); } while (x > 0);
    words.push(6, ew.length >> 5, ew.length & 31, ...ew);
  }
  const hw = bech32.toWords(Uint8Array.from(Buffer.from(paymentHashHex, "hex")));
  words.push(1, 52 >> 5, 52 & 31, ...hw);
  for (let i = 0; i < 104; i++) words.push(0);
  return bech32.encode(`lnbc${opts.amountHrp ?? ""}`, words, 2000);
}

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

export { buildInvoice };
