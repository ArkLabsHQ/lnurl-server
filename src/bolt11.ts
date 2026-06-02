/**
 * Decode the amount encoded in a BOLT11 invoice's human-readable prefix (HRP),
 * in millisatoshis. Returns null if the invoice is amountless or unparseable.
 *
 * No bech32/data decode is needed: the bech32 separator is the last "1" in the
 * string (the data charset excludes "1"), and the amount + multiplier live in the
 * HRP, e.g. "lnbc100n" → 100 nano-BTC. Multipliers: m=milli, u=micro, n=nano, p=pico.
 */
export function decodeInvoiceAmountMsat(pr: string): number | null {
  if (typeof pr !== "string") return null;
  const s = pr.toLowerCase();
  const sep = s.lastIndexOf("1");
  if (sep <= 0) return null;
  const hrp = s.slice(0, sep);

  const m = /^ln[a-z]+?(\d+)([munp])?$/.exec(hrp);
  if (!m) return null; // amountless or unparseable

  const amount = BigInt(m[1]!);
  const mult = m[2];
  const MSAT_PER_BTC = 100_000_000_000n; // 1 BTC = 10^11 msat

  let msat: bigint;
  switch (mult) {
    case undefined:
      msat = amount * MSAT_PER_BTC;
      break;
    case "m": // milli → 10^8 msat
      msat = amount * (MSAT_PER_BTC / 1_000n);
      break;
    case "u": // micro → 10^5 msat
      msat = amount * (MSAT_PER_BTC / 1_000_000n);
      break;
    case "n": // nano → 10^2 msat
      msat = amount * (MSAT_PER_BTC / 1_000_000_000n);
      break;
    case "p": // pico → 0.1 msat; must be a multiple of 10 to be an integer msat
      if (amount % 10n !== 0n) return null;
      msat = amount / 10n;
      break;
    default:
      return null;
  }

  return Number(msat);
}
