import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";

const MESSAGE_PREFIX = "lnurl-session:";

/** The canonical form of a LUD-16 domain. Exported so the covenant supply salts
 *  and this token agree by construction rather than by two copies of
 *  `.trim().toLowerCase()` staying in step. */
export function normaliseDomain(domain: string): string {
  const normalised = domain.trim().toLowerCase();
  if (!normalised) throw new Error("a session token must be bound to a domain");
  return normalised;
}

/**
 * The 32-byte digest both derivations sign.
 *
 * The domain is in the message, and leaving it out is a vulnerability rather
 * than a simplification. The token is a bearer credential that servers both
 * receive and persist (`address-service.ts:41,48,55,75` store it encrypted at
 * rest), so a domain-independent token would authenticate its holder at every
 * lnurl-server the user has ever touched — letting a malicious or breached
 * server repoint the victim's Arkade receive identity elsewhere, which the
 * covenant then faithfully pays.
 *
 * Bound to the LUD-16 domain rather than the base URL: the domain is canonical
 * and user-visible, where base URLs vary by scheme, port and trailing slash and
 * would fork an identity on a formatting difference.
 *
 * @param domain - The LUD-16 domain, e.g. `example.com`. Trimmed and lowercased.
 * @returns The 32-byte digest to sign.
 */
export function sessionTokenMessage(domain: string): Uint8Array {
  return sha256(new TextEncoder().encode(MESSAGE_PREFIX + normaliseDomain(domain)));
}

function tokenFromSignature(signature: Uint8Array): string {
  return hex.encode(sha256(signature));
}

/**
 * Derives the session token from a raw private key.
 *
 * Produces exactly the same token as {@link deriveSessionTokenWithSigner},
 * because it performs the same deterministic ECDSA signature itself — so a
 * wallet can move between the two without losing ownership of its addresses.
 *
 * Prefer the signer form where an `Identity` is available: this one requires
 * the caller to hand over key material, which a library should not need.
 *
 * @param privateKeyHex - Private key as a hex string.
 * @param domain - The LUD-16 domain this token is for.
 * @returns The session token as a hex string, valid only at that domain.
 */
export function deriveSessionToken(privateKeyHex: string, domain: string): string {
  // `prehash: false` because the message already is the digest — the same call
  // ts-sdk's Identity makes for "ecdsa", so both paths sign identical bytes.
  const signature = secp256k1.sign(sessionTokenMessage(domain), hex.decode(privateKeyHex), { prehash: false });
  return tokenFromSignature(signature);
}

/**
 * Derives the session token from a signer, so the private key never leaves the
 * wallet. `@arkade-os/ts-sdk`'s `Identity` satisfies this structurally:
 *
 * ```ts
 * const token = await deriveSessionTokenWithSigner(
 *   (msg, type) => identity.signMessage(msg, type),
 *   'example.com',
 * )
 * ```
 *
 * **ECDSA specifically, and the type is passed for you.** BIP-340 schnorr is
 * randomised unless an explicit aux is supplied, which `Identity.signMessage`
 * does not expose — and schnorr is its *default* signature type. A schnorr
 * signature is also 64 bytes, exactly like a compact ECDSA one, so nothing
 * about the returned bytes reveals the mistake. A non-deterministic signer
 * would mint a fresh token on every call and silently orphan the address, so
 * this signs twice and compares rather than trusting the caller to have wired
 * it correctly.
 *
 * @param signMessage - Signs a digest; called with `"ecdsa"` by this function.
 * @param domain - The LUD-16 domain this token is for.
 * @returns The session token as a hex string, identical to the key-derived one.
 */
export async function deriveSessionTokenWithSigner(
  signMessage: (message: Uint8Array, signatureType: "ecdsa") => Promise<Uint8Array>,
  domain: string,
): Promise<string> {
  const message = sessionTokenMessage(domain);
  const first = await signMessage(message, "ecdsa");
  const second = await signMessage(message, "ecdsa");
  if (first.length !== second.length || !first.every((b, i) => b === second[i])) {
    throw new Error(
      "signer is not deterministic: signing the same message twice differed, so the derived token would change " +
        "on every call and orphan the address. Use RFC6979 ECDSA, not randomised schnorr.",
    );
  }
  return tokenFromSignature(first);
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
