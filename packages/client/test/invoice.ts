import { bech32, hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";

/** A structurally valid bolt11 carrying only a description and the payment hash; the signature is zeros. */
export function buildInvoice(paymentHashHex: string): string {
  const words: number[] = [0, 0, 0, 0, 0, 0, 0];
  const desc = bech32.toWords(new TextEncoder().encode("hello"));
  words.push(13, desc.length >> 5, desc.length & 31, ...desc);
  const hw = bech32.toWords(hex.decode(paymentHashHex));
  words.push(1, 52 >> 5, 52 & 31, ...hw);
  for (let i = 0; i < 104; i++) words.push(0);
  return bech32.encode("lnbc", words, 2000);
}

export const PREIMAGE = "ab".repeat(32);
export const HASH = hex.encode(sha256(hex.decode(PREIMAGE)));
export const INVOICE = buildInvoice(HASH);
