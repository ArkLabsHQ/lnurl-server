import { bech32 } from "@scure/base";
import { LnurlError } from "./errors.js";

export type LnurlSurface = "address" | "session";

const ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isLnAddress(input: string): boolean {
  return ADDRESS_PATTERN.test(input);
}

export function isLnUrl(input: string): boolean {
  try {
    // Decoded as given, never lowercased first: bech32 rejects mixed case on
    // purpose (BIP-173), because case-mangling defeats the checksum's error
    // detection. Uppercase LNURLs — what QR codes carry — still decode, and
    // decodeToBytes normalises the prefix to lowercase either way.
    const decoded = bech32.decodeToBytes(input);
    if (decoded.prefix !== "lnurl") return false;
    const text = new TextDecoder().decode(decoded.bytes);
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
    const url = new TextDecoder().decode(bech32.decodeToBytes(input).bytes);
    // Options/units/offline rails live only on the address surface; the session
    // callback reads amount and comment, so Task 4 keys its guards off this.
    const surface: LnurlSurface = url.includes("/.well-known/lnurlp/") ? "address" : "session";
    return { url, surface };
  }
  throw new LnurlError("Not a valid LNURL or lightning address");
}
