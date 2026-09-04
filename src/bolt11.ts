import { bech32 } from "@scure/base";
import type { InvoiceFacts } from "./vendor/arkade-swap/rfq.js";

/** Extract the payment hash (lowercase hex) from a bolt11 invoice, or null if it
 *  can't be parsed. Local + dependency-free: bech32-decodes the invoice and walks
 *  the tagged fields for the `p` (type 1) field.
 *
 *  A bolt11 data part is: a 7-word (35-bit) timestamp, a run of tagged fields
 *  (each `type[1 word] + length[2 words] + data[length words]`), then a trailing
 *  104-word (65-byte) signature. The payment hash is the `p` field's 52 words
 *  (256 bits + 4 bits zero padding). Signature validity is irrelevant here. */
export function paymentHashFromBolt11(pr: string): string | null {
  try {
    const { words } = bech32.decode(pr.toLowerCase() as `${string}1${string}`, 2000);
    const end = words.length - 104;
    let i = 7;
    while (i < end) {
      const type = words[i];
      const len = (words[i + 1] << 5) | words[i + 2];
      const dataStart = i + 3;
      const dataEnd = dataStart + len;
      if (dataEnd > end) break;
      if (type === 1) {
        const bytes = bech32.fromWordsUnsafe(words.slice(dataStart, dataStart + 52));
        return bytes ? Buffer.from(bytes.slice(0, 32)).toString("hex") : null;
      }
      i = dataEnd;
    }
    return null;
  } catch {
    return null;
  }
}

// BOLT11 amount multipliers, in msat per unit of the HRP amount.
const MULTIPLIER_MSAT: Record<string, bigint> = {
  m: 100_000_000n,
  u: 100_000n,
  n: 100n,
  p: 1n, // 0.1 msat — divided by 10 below (BOLT11 rounds down)
};
const WHOLE_BTC_MSAT = 100_000_000_000n;
const DEFAULT_EXPIRY_SECONDS = 3600;

/** 5-bit words as a big-endian integer (timestamps, expiry values). */
function wordsToInt(words: ArrayLike<number>): number {
  let v = 0;
  for (let i = 0; i < words.length; i++) v = v * 32 + words[i];
  return v;
}

/** Decode the fields the offline-receive invoice gate checks: payment hash, amount
 *  (HRP), and absolute expiry (timestamp + `x` tag, default 3600s). Throws on an
 *  undecodable invoice — the caller ({@link verifyReceiveInvoice}) treats a throw as
 *  `invoice_undecodable`. Amountless invoices decode to `amountSats: 0`. */
export function invoiceFactsFromBolt11(pr: string): InvoiceFacts {
  const raw = pr.toLowerCase();
  const { prefix, words } = bech32.decode(raw as `${string}1${string}`, 2000);
  const hrp = /^ln[a-z]+(?:(\d+)([munp])?)?$/.exec(prefix);
  if (!hrp) throw new Error(`unrecognized bolt11 hrp: ${prefix}`);

  let amountSats = 0;
  if (hrp[1] !== undefined) {
    const digits = BigInt(hrp[1]);
    const mult = hrp[2];
    if (mult === undefined) {
      amountSats = Number((digits * WHOLE_BTC_MSAT) / 1000n);
    } else {
      const msat = (digits * MULTIPLIER_MSAT[mult]) / (mult === "p" ? 10n : 1n);
      amountSats = Number(msat / 1000n);
    }
  }

  const timestamp = wordsToInt(words.slice(0, 7));
  const end = words.length - 104;
  let paymentHash: string | null = null;
  let expiry: number | undefined;
  let i = 7;
  while (i < end) {
    const type = words[i];
    const len = (words[i + 1] << 5) | words[i + 2];
    const dataStart = i + 3;
    const dataEnd = dataStart + len;
    if (dataEnd > end) break;
    if (type === 1) {
      const bytes = bech32.fromWordsUnsafe(words.slice(dataStart, dataStart + 52));
      if (bytes) paymentHash = Buffer.from(bytes.slice(0, 32)).toString("hex");
    } else if (type === 6) {
      expiry = wordsToInt(words.slice(dataStart, dataEnd));
    }
    i = dataEnd;
  }
  if (!paymentHash) throw new Error("bolt11 carries no payment hash");
  return { raw, paymentHash, amountSats, expiresAt: timestamp + (expiry ?? DEFAULT_EXPIRY_SECONDS) };
}
