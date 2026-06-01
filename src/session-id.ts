import { createHash } from "node:crypto";

/** Derive a sessionId from a token: first 32 hex chars of SHA-256(token bytes). */
export function deriveSessionId(tokenHex: string): string {
  return createHash("sha256").update(Buffer.from(tokenHex, "hex")).digest("hex").slice(0, 32);
}
