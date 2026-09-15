import { bech32 } from "@scure/base";
import { LnurlError } from "./errors.js";

export type LnurlSurface = "address" | "session";

const ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isLnAddress(input: string): boolean {
  return ADDRESS_PATTERN.test(input);
}

// A real LNURL is far longer than bech32's 90-char default — the server encodes
// with 1023 (src/lnurl.ts:5) — and @scure/base >= 2.4 enforces that default in
// decodeToBytes, so the limit has to be passed explicitly or every production
// LNURL fails. `decode` still rejects mixed case, which BIP-173 requires so that
// case-mangling in transit cannot slip past the checksum, and it normalises the
// prefix, so uppercase LNURLs (what QR codes carry) decode fine.
const LNURL_BECH32_LIMIT = 1023;

function decodeLnurl(input: string): { prefix: string; text: string } {
  const { prefix, words } = bech32.decode(input as `${string}1${string}`, LNURL_BECH32_LIMIT);
  return { prefix, text: new TextDecoder().decode(Uint8Array.from(bech32.fromWords(words))) };
}

export function isLnUrl(input: string): boolean {
  try {
    const { prefix, text } = decodeLnurl(input);
    if (prefix !== "lnurl") return false;
    return text.startsWith("https://") || text.startsWith("http://");
  } catch {
    return false;
  }
}

export function isValidLnUrl(input: string): boolean {
  return isLnAddress(input) || isLnUrl(input);
}

export function toPayRequestUrl(input: string): { url: string; surface: LnurlSurface } {
  if (isLnAddress(input)) {
    const [user, domain] = input.split("@");
    return { url: `https://${domain}/.well-known/lnurlp/${user.toLowerCase()}`, surface: "address" };
  }
  if (isLnUrl(input)) {
    const url = decodeLnurl(input).text;
    // Options/units/offline rails live only on the address surface; the session
    // callback reads amount and comment, so Task 4 keys its guards off this.
    const surface: LnurlSurface = url.includes("/.well-known/lnurlp/") ? "address" : "session";
    return { url, surface };
  }
  throw new LnurlError("Not a valid LNURL or lightning address");
}
