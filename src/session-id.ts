import { createHash } from "node:crypto";
import { InvalidSessionTokenError } from "./errors.js";

/** A session token: whole bytes of hex, at least 16 of them. */
export function isValidToken(token: string): boolean {
  return /^(?:[0-9a-f]{2})+$/i.test(token) && token.length >= 32;
}

/** Derive a sessionId from a token: first 32 hex chars of SHA-256(token bytes). */
export function deriveSessionId(tokenHex: string): string {
  // Buffer.from(hex) silently truncates at the first bad pair, mapping distinct tokens to one id.
  if (!isValidToken(tokenHex)) {
    throw new InvalidSessionTokenError();
  }
  return createHash("sha256").update(Buffer.from(tokenHex, "hex")).digest("hex").slice(0, 32);
}
