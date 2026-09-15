import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";

// Byte-compatible with the wallet deriveLnurlCredentials: the session id owns registered addresses.
/**
 * Derives the reusable session token from a private key: hex of
 * `HMAC-SHA256(key = private-key bytes, message = utf8("lnurl-session"))`.
 *
 * The formula is byte-compatible with the wallet's `deriveLnurlCredentials`
 * so the two never diverge; it is pinned by a fixed known-answer vector in
 * the tests. Pure and key-agnostic otherwise: the caller holds the key and
 * only hands the derived token to the client.
 *
 * @param privateKeyHex - Private key as a hex string.
 * @returns The session token as a hex string.
 */
export function deriveSessionToken(privateKeyHex: string): string {
  return hex.encode(hmac(sha256, hex.decode(privateKeyHex), new TextEncoder().encode("lnurl-session")));
}

/**
 * Derives the session id from a token: the first 32 hex chars of
 * `sha256(hexDecode(token))`, hashing the token's bytes, not its hex string.
 *
 * Must agree with the server's derivation (`src/session-id.ts`): the id is
 * both the live session key and the ownership key for registered LUD-16
 * lightning addresses, so a mismatch would orphan addresses and sessions.
 *
 * @param tokenHex - Session token as a hex string.
 * @returns The 32-hex-char session id.
 */
export function deriveSessionId(tokenHex: string): string {
  return hex.encode(sha256(hex.decode(tokenHex))).slice(0, 32);
}

