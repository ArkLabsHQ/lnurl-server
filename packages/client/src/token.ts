import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";

/**
 * Derives the reusable session token for ONE domain: hex of
 * `HMAC-SHA256(key = private-key bytes, message = utf8("lnurl-session:<domain>"))`.
 *
 * The domain is part of the message on purpose, and omitting it is a
 * vulnerability rather than a simplification. The token is a bearer
 * credential that servers both receive and persist
 * (`address-service.ts:41,48,55,75` store it encrypted at rest), so a token
 * derived from a constant authenticates its holder at *every* lnurl-server
 * the user has ever touched. A malicious or breached server could then call
 * `POST /lnurl/address/:username/arkade` on a different server and repoint
 * the victim's Arkade receive identity — which the covenant then faithfully
 * pays, because `enforcePayTo` constrains the claim to whatever address is
 * currently registered. Binding to the domain makes a token minted for
 * `example.com` useless at `other.com`.
 *
 * This cannot be enforced server-side: the server sees an opaque token and
 * cannot tell which domain it was derived for, so the protection only holds
 * for clients that derive this way. The structural fix is proof-of-possession
 * rather than a bearer credential; this is the cheap mitigation that removes
 * the cross-server class today.
 *
 * @param privateKeyHex - Private key as a hex string.
 * @param domain - The LUD-16 domain this token is for, e.g. `example.com`.
 *   Compared case-insensitively; the domain rather than the base URL because
 *   it is canonical and user-visible, where base URLs vary by scheme, port
 *   and trailing slash.
 * @returns The session token as a hex string, valid only at that domain.
 */
export function deriveSessionToken(privateKeyHex: string, domain: string): string {
  const normalised = domain.trim().toLowerCase();
  if (!normalised) throw new Error("deriveSessionToken requires the domain the token is for");
  const message = new TextEncoder().encode(`lnurl-session:${normalised}`);
  return hex.encode(hmac(sha256, hex.decode(privateKeyHex), message));
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

