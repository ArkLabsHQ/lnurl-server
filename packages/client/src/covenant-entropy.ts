/**
 * Deterministic preimage supply for the server's per-payment covenant destinations.
 * The preimage is one of six values a covenant address commits to, and the server
 * used to mint it with `randomBytes`, so a user whose server vanished could not
 * rebuild the script their money sits at. Here the wallet mints them from its own
 * key and uploads a batch the server spends. The SDK's primitive needs the private
 * key, so a keyless server cannot participate — that is the point.
 */
import { buildSaltedPreimageMessage } from "@arkade-os/sdk";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { hex } from "@scure/base";
import { LnurlError } from "./errors.js";
import { normaliseDomain } from "./token.js";

/** The only supply scheme this version speaks. */
export const COVENANT_SUPPLY_SCHEME = "salted-v1";
/** Matches the server's per-upload cap. */
export const COVENANT_SUPPLY_MAX = 256;

/** Which rail a supply feeds. Never share one: the covenant sweep leaf and the
 *  swap VHTLC would hash to the same secret, so a reveal on one unlocks the other. */
export type SupplyLeg = "covenant" | "swap";

const DOMAIN_TAG: Record<SupplyLeg, string> = {
  covenant: "lnurl-covenant-salt:v1",
  swap: "lnurl-swap-salt:v1",
};

/** The slice of the SDK's `Identity` a supply needs; `SingleKey`, `SeedIdentity`
 *  and `MnemonicIdentity` all satisfy it structurally. */
export interface SupplySigner {
  xOnlyPublicKey(): Promise<Uint8Array>;
  signSchnorrDeterministic(messageHash: Uint8Array): Promise<Uint8Array>;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function u32le(value: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, value, true);
  return b;
}

function assertIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index > 0xffff_ffff) {
    throw new LnurlError(`supply index must be a u32, got ${index}`);
  }
}

/** The public 32-byte salt for one slot — it reveals nothing without the key.
 *  Every field is fixed-width and hashed before concatenation, so no two distinct
 *  (leg, domain, index) triples collide at a boundary; the domain shares
 *  {@link normaliseDomain} with the session token. */
export function supplySalt(leg: SupplyLeg, domain: string, index: number): Uint8Array {
  assertIndex(index);
  const tag = DOMAIN_TAG[leg];
  if (!tag) throw new LnurlError(`unknown supply leg: ${String(leg)}`);
  return sha256(concat(sha256(utf8(tag)), sha256(utf8(normaliseDomain(domain))), u32le(index)));
}

/** Derives one 32-byte supply preimage from the wallet's own key; `identity` must
 *  sign deterministically, so `signMessage` is NOT enough. The SDK's *salted* arm,
 *  not its HD arm — the HD arm consumes the wallet's signing-descriptor watermark,
 *  entangling this with its own swap allocations. */
export async function derivePreimage(
  identity: SupplySigner,
  leg: SupplyLeg,
  domain: string,
  index: number,
): Promise<Uint8Array> {
  const xonly = await identity.xOnlyPublicKey();
  const message = buildSaltedPreimageMessage(xonly, supplySalt(leg, domain, index));
  return sha256(await identity.signSchnorrDeterministic(sha256(message)));
}

/** The 20-byte HASH160 the covenant sweep leaf commits to, so a recovering wallet
 *  can match a re-derived preimage against a script a payment landed at. */
export function preimageHash160(preimage: Uint8Array): Uint8Array {
  if (preimage.length !== 32) throw new LnurlError(`preimage must be 32 bytes, got ${preimage.length}`);
  return ripemd160(sha256(preimage));
}

export interface CovenantSupply {
  scheme: string;
  startIndex: number;
  preimages: string[];
}

/** Mints a contiguous batch of hex preimages for `covenantSupply`. `startIndex`
 *  must equal the server's reported `nextIndex`; a gap is rejected. */
export async function mintCovenantSupply(
  identity: SupplySigner,
  params: { leg?: SupplyLeg; domain: string; startIndex: number; count: number },
): Promise<CovenantSupply> {
  const leg = params.leg ?? "covenant";
  assertIndex(params.startIndex);
  if (!Number.isInteger(params.count) || params.count < 1 || params.count > COVENANT_SUPPLY_MAX) {
    throw new LnurlError(`count must be between 1 and ${COVENANT_SUPPLY_MAX}, got ${params.count}`);
  }
  const preimages: string[] = [];
  for (let i = 0; i < params.count; i++) {
    preimages.push(hex.encode(await derivePreimage(identity, leg, params.domain, params.startIndex + i)));
  }
  return { scheme: COVENANT_SUPPLY_SCHEME, startIndex: params.startIndex, preimages };
}
