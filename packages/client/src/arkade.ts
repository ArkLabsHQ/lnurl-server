/**
 * Arkade-aware helpers, published as `@arkade-os/lnurl-client/arkade`.
 *
 * Kept off the main entry point on purpose. The payer half of this package —
 * `resolve`, `requestInvoice`, `pollVerify` — has nothing to do with Arkade, so
 * a checkout page should not pull `@arkade-os/sdk` and its Expo peers to ask an
 * address for an invoice. Import this module only in a receiver, where the SDK
 * is already present.
 */
import { ArkAddress } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { LnurlError } from "./errors.js";
import { deriveSessionTokenWithSigner } from "./token.js";

export { LNURL_ARKADE_RAIL, LNURL_LIGHTNING_RAIL, lnurlRails } from "./rail.js";
export type { LnurlRailDeps } from "./rail.js";
export { arkadeLnurl, arkadePaymentRouter, encodeLnurl, DEFAULT_RAIL_PRIORITY } from "./wallet.js";
export type { ArkadeLnurl, ArkadeLnurlConfig, ArkadeLnurlOptions, ArkadeLnurlSource, ClaimOptions, NameOptions, Receiver } from "./wallet.js";

/** The slice of `@arkade-os/sdk`'s `Identity` these helpers need. */
export interface ArkadeSigner {
  signMessage(message: Uint8Array, signatureType: "schnorr" | "ecdsa"): Promise<Uint8Array>;
  compressedPublicKey(): Promise<Uint8Array>;
}

/**
 * True when `address` decodes as an Arkade address.
 *
 * The core package deliberately cannot do this — decoding needs the SDK — so
 * without this helper a malformed address is only caught server-side, a round
 * trip later.
 *
 * @param address - Bech32m Arkade address.
 * @returns Whether it decodes.
 */
export function isArkadeAddress(address: string): boolean {
  try {
    ArkAddress.decode(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Derives the session token from an `Identity`, signing with ECDSA.
 *
 * Prefer this over calling {@link deriveSessionTokenWithSigner} yourself: it
 * pins the signature type. Schnorr is `Identity.signMessage`'s default and is
 * randomised without an explicit aux, which would mint a fresh token per call
 * and orphan the address — and a schnorr signature is 64 bytes exactly like a
 * compact ECDSA one, so nothing about the bytes reveals the mistake.
 *
 * Produces the same token as `deriveSessionToken(privateKeyHex, domain)`.
 *
 * **Signs twice**, inherited from {@link deriveSessionTokenWithSigner}, to
 * prove the signer is deterministic before a token derived from it is used as
 * an address's identity. Free for a software key; an `Identity` backed by a
 * device that prompts will prompt twice, once per call. Derive once per domain
 * and hold the result for the session rather than calling it per request.
 *
 * @param identity - Anything with `@arkade-os/sdk`'s `signMessage`.
 * @param domain - The LUD-16 domain this token is for.
 * @returns The session token as hex, valid only at that domain.
 */
export function deriveSessionTokenForIdentity(identity: ArkadeSigner, domain: string): Promise<string> {
  return deriveSessionTokenWithSigner((message) => identity.signMessage(message, "ecdsa"), domain);
}

/**
 * The identity's compressed public key as hex — the `claimPublicKey` that
 * `registerArkadeIdentity` wants, in the form the server validates.
 *
 * @param identity - Anything with `@arkade-os/sdk`'s `compressedPublicKey`.
 * @returns 66-hex-char compressed key.
 */
export async function claimPublicKeyOf(identity: ArkadeSigner): Promise<string> {
  const key = await identity.compressedPublicKey();
  if (key.length !== 33) {
    throw new LnurlError(`expected a 33-byte compressed public key, got ${key.length} bytes`);
  }
  return hex.encode(key);
}

/**
 * Builds the `registerArkadeIdentity` request from an `Identity`, validating the
 * Arkade address before it reaches the wire.
 *
 * An optional `boardingAddress` registers the onchain rail in the same call,
 * unchecked: it is a Bitcoin address on a network this helper cannot know.
 *
 * @param params - The identity, its Arkade address, the owning token and handle.
 * @returns The request body to hand to `registerArkadeIdentity`.
 */
export async function arkadeIdentityRequest(params: {
  identity: ArkadeSigner;
  arkadeAddress: string;
  token: string;
  handle: string;
  boardingAddress?: string;
  domain?: string;
}): Promise<{
  token: string;
  handle: string;
  arkadeAddress: string;
  claimPublicKey: string;
  boardingAddress?: string;
  domain?: string;
}> {
  if (!isArkadeAddress(params.arkadeAddress)) {
    throw new LnurlError(`not a valid Arkade address: ${params.arkadeAddress}`);
  }
  return {
    token: params.token,
    handle: params.handle,
    arkadeAddress: params.arkadeAddress,
    claimPublicKey: await claimPublicKeyOf(params.identity),
    ...(params.boardingAddress !== undefined ? { boardingAddress: params.boardingAddress } : {}),
    ...(params.domain !== undefined ? { domain: params.domain } : {}),
  };
}
