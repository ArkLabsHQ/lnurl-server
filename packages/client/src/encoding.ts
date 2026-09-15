import { bech32 } from "@scure/base";
import { LnurlError } from "./errors.js";

/**
 * Which half of the protocol a payRequest URL belongs to. Options, units and
 * the offline rails live only on the address surface; the session callback
 * reads `amount` and `comment` and nothing else, so the payer guards key off
 * this value.
 */
export type LnurlSurface = "address" | "session";

const ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Reports whether the input looks like a lightning address (`user@domain`).
 *
 * This is a shape check only; it never touches the network, so a well-formed
 * but unregistered address still returns true here and fails at `resolve`.
 *
 * @param input - The raw user input to test.
 * @returns True when the input has the `user@domain` shape.
 */
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

/**
 * Reports whether the input is a bech32 LNURL that decodes to an http(s) URL.
 *
 * Decoded with an explicit 1023 limit because real LNURLs exceed bech32's
 * 90-char default; mixed case is rejected per BIP-173, while an all-uppercase
 * LNURL (what QR codes carry) still decodes fine.
 *
 * @param input - The raw user input to test.
 * @returns True when the input is a well-formed LNURL.
 */
export function isLnUrl(input: string): boolean {
  try {
    const { prefix, text } = decodeLnurl(input);
    if (prefix !== "lnurl") return false;
    return text.startsWith("https://") || text.startsWith("http://");
  } catch {
    return false;
  }
}

/**
 * Reports whether the input is payable input of either shape: a lightning
 * address or a bech32 LNURL.
 *
 * @param input - The raw user input to test.
 * @returns True for a lightning address or a well-formed LNURL.
 */
export function isValidLnUrl(input: string): boolean {
  return isLnAddress(input) || isLnUrl(input);
}

/**
 * Maps user input to the payRequest URL plus the surface it belongs to.
 *
 * A lightning address resolves against `https://domain/.well-known/lnurlp/user`
 * with a lowercased username; a bech32 LNURL carries its own URL. The surface
 * is `address` for `/.well-known/lnurlp/` URLs and `session` otherwise, which
 * is what the payer rail guards are keyed off.
 *
 * @param input - A lightning address or bech32 LNURL.
 * @returns The payRequest `url` and its `surface`.
 */
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
