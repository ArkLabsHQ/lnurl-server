import { describe, it, expect } from "vitest";
import { bech32 } from "@scure/base";
import { createHash } from "node:crypto";
import { paymentHashFromBolt11 } from "../src/bolt11.js";

/** Build a structurally-valid bolt11 whose payment-hash field is `paymentHashHex`.
 *  Layout: 35-bit timestamp, a decoy `d` field (type 13), the `p` field
 *  (type 1, len 52), then 104 dummy signature words. The decoder must skip the
 *  decoy field to find the payment hash. Signature bytes are not valid — the
 *  decoder does not (and need not) verify them. */
function buildInvoice(paymentHashHex: string): string {
  const words: number[] = [];
  for (let i = 0; i < 7; i++) words.push(0);
  const desc = bech32.toWords(new TextEncoder().encode("hello"));
  words.push(13, desc.length >> 5, desc.length & 31, ...desc);
  const hw = bech32.toWords(Uint8Array.from(Buffer.from(paymentHashHex, "hex")));
  words.push(1, 52 >> 5, 52 & 31, ...hw);
  for (let i = 0; i < 104; i++) words.push(0);
  return bech32.encode("lnbc", words, 2000);
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

export { buildInvoice };
