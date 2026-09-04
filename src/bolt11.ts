import { bech32 } from "@scure/base";

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
