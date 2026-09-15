import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";

// Byte-compatible with the wallet deriveLnurlCredentials: the session id owns registered addresses.
export function deriveSessionToken(privateKeyHex: string): string {
  return hex.encode(hmac(sha256, hex.decode(privateKeyHex), new TextEncoder().encode("lnurl-session")));
}

export function deriveSessionId(tokenHex: string): string {
  return hex.encode(sha256(hex.decode(tokenHex))).slice(0, 32);
}

