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
