import { bech32 } from "@scure/base";

/** Build a structurally-valid bolt11 whose payment-hash field is `paymentHashHex`.
 *  Layout: 35-bit timestamp, a decoy `d` field (type 13), an optional `x` expiry
 *  field (type 6), the `p` field (type 1, len 52), then 104 dummy signature words.
 *  Signature bytes are not valid — the decoder does not (and need not) verify them. */
export function buildInvoice(paymentHashHex: string, opts: { amountHrp?: string; timestamp?: number; expirySeconds?: number } = {}): string {
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
