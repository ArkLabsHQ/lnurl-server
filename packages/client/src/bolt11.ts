import { bech32, hex } from "@scure/base";

/**
 * The payment hash (lowercase hex) of a bolt11 invoice, or null when it cannot
 * be decoded. Walks the tagged fields for `p` (type 1) between the 7-word
 * timestamp and the 104-word signature; the signature itself is not checked.
 */
export function paymentHashOf(pr: string): string | null {
  try {
    const { words } = bech32.decode(pr.toLowerCase() as `${string}1${string}`, 2000);
    const end = words.length - 104;
    for (let i = 7; i < end; ) {
      const len = (words[i + 1]! << 5) | words[i + 2]!;
      const dataEnd = i + 3 + len;
      if (dataEnd > end) return null;
      if (words[i] === 1) {
        const bytes = bech32.fromWordsUnsafe(words.slice(i + 3, i + 3 + 52));
        return bytes ? hex.encode(bytes.slice(0, 32)) : null;
      }
      i = dataEnd;
    }
    return null;
  } catch {
    return null;
  }
}

const MULTIPLIER_DIVISOR: Record<string, bigint> = { m: 1_000n, u: 1_000_000n, n: 1_000_000_000n, p: 1_000_000_000_000n };

/**
 * The amount (in millisats) encoded in a bolt11 invoice's HRP, per BOLT11's
 * m/u/n/p multipliers (value * 10^11 / divisor, no multiplier = whole BTC).
 * `null` when the invoice decodes but carries no amount (amountless);
 * `undefined` when the invoice itself does not decode.
 */
export function amountMsatOf(pr: string): number | null | undefined {
  let prefix: string;
  try {
    ({ prefix } = bech32.decode(pr.toLowerCase() as `${string}1${string}`, 2000));
  } catch {
    return undefined;
  }
  const match = /^ln[a-z]+(\d+)([munp])?$/.exec(prefix);
  if (!match) return null;
  const [, digits, mult] = match;
  const divisor = mult ? MULTIPLIER_DIVISOR[mult]! : 1n;
  const numerator = BigInt(digits!) * 100_000_000_000n;
  if (numerator % divisor !== 0n) return undefined;
  const msat = numerator / divisor;
  return msat <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(msat) : undefined;
}
