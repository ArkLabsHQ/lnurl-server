import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ArkAddress } from "@arkade-os/sdk";
import { isRailId, type RailId } from "../rails.js";

/**
 * Canonical encoding for an owner-signed receive setup. Not wired into any
 * route yet: this is the primitive Task 4 needs, proposed ahead of the rest so
 * the bytes a wallet must sign can be reviewed on their own.
 *
 * Signed with schnorr rather than the ECDSA the session token pins. That pin
 * exists because a token derived from a signature has to be deterministic; a
 * stored signature does not, so the SDK's default applies.
 */
export interface OwnerSetup {
  deployment: string;
  tenant: string;
  network: string;
  /** Lowercase, as stored. */
  domain: string;
  /** Lowercase, as stored. */
  username: string;
  /** BIP340 x-only key that owns this setup, 32 bytes hex. */
  ownerPublicKey: string;
  /** Where offline receives pay out — the field the setup exists to protect. */
  arkadeDestination: string;
  /** Compressed secp256k1, 33 bytes hex. */
  claimPublicKey: string;
  boardingAddress?: string;
  /** In preference order; order is part of the record. */
  rails: readonly RailId[];
  /** 1 for the first setup, which alone has no previous hash. */
  revision: number;
  previousHash?: string;
}

const TAG = "lnurl.enclave.setup.v1";
const MAX_FIELD = 65_535;

function lengthPrefixed(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > MAX_FIELD) throw new Error("owner setup field is too long to encode");
  const out = new Uint8Array(2 + bytes.length);
  new DataView(out.buffer).setUint16(0, bytes.length);
  out.set(bytes, 2);
  return out;
}

function u16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value);
  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

function fixedHex(value: string, bytes: number, what: string): Uint8Array {
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)) {
    throw new Error(`owner setup ${what} must be ${bytes} bytes of lowercase hex`);
  }
  return Uint8Array.from(value.match(/../g)!.map((b) => parseInt(b, 16)));
}

function optional(part: Uint8Array | undefined): Uint8Array[] {
  return part === undefined ? [Uint8Array.of(0)] : [Uint8Array.of(1), part];
}

function isCanonicalArkAddress(value: string): boolean {
  try {
    return ArkAddress.decode(value).encode() === value;
  } catch {
    return false;
  }
}

function assertValid(setup: OwnerSetup): void {
  for (const [name, value] of [["deployment", setup.deployment], ["tenant", setup.tenant], ["network", setup.network]] as const) {
    if (!value) throw new Error(`owner setup ${name} must not be empty`);
  }
  for (const [name, value] of [["domain", setup.domain], ["username", setup.username]] as const) {
    if (!value || value !== value.toLowerCase()) throw new Error(`owner setup ${name} must be non-empty and lowercase, as stored`);
  }
  if (!isCanonicalArkAddress(setup.arkadeDestination)) {
    throw new Error("owner setup arkadeDestination must be a canonical Arkade address");
  }
  if (!/^0[23][0-9a-f]{64}$/.test(setup.claimPublicKey)) {
    throw new Error("owner setup claimPublicKey must be a compressed secp256k1 key");
  }
  if (setup.boardingAddress === "") throw new Error("owner setup boardingAddress must be omitted rather than empty");
  if (!setup.rails.every(isRailId)) throw new Error("owner setup rails must be known rail ids");
  if (new Set(setup.rails).size !== setup.rails.length) throw new Error("owner setup rails must not repeat");
  if (!Number.isInteger(setup.revision) || setup.revision < 1 || setup.revision > 0xffff_ffff) {
    throw new Error("owner setup revision must be a uint32 of at least 1");
  }
  if ((setup.revision === 1) !== (setup.previousHash === undefined)) {
    throw new Error("owner setup previousHash is required after the first revision and forbidden on it");
  }
}

/**
 * Fields follow the design's order. Every variable-length field is
 * length-prefixed so no two different records can encode to the same bytes —
 * concatenation alone would let a character move across a boundary unnoticed.
 */
export function encodeOwnerSetup(setup: OwnerSetup): Uint8Array {
  assertValid(setup);
  const parts: Uint8Array[] = [
    Uint8Array.of(1),
    lengthPrefixed(setup.deployment),
    lengthPrefixed(setup.tenant),
    lengthPrefixed(setup.network),
    lengthPrefixed(setup.domain),
    lengthPrefixed(setup.username),
    fixedHex(setup.ownerPublicKey, 32, "ownerPublicKey"),
    lengthPrefixed(setup.arkadeDestination),
    fixedHex(setup.claimPublicKey, 33, "claimPublicKey"),
    ...optional(setup.boardingAddress === undefined ? undefined : lengthPrefixed(setup.boardingAddress)),
    u16(setup.rails.length),
    ...setup.rails.map(lengthPrefixed),
    u32(setup.revision),
    ...optional(setup.previousHash === undefined ? undefined : fixedHex(setup.previousHash, 32, "previousHash")),
  ];

  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** BIP340-style tagged hash, so this digest cannot be a valid signature over
 *  anything else the owner's key is ever asked to sign. */
export function ownerSetupDigest(setup: OwnerSetup): Uint8Array {
  const tag = sha256(new TextEncoder().encode(TAG));
  const payload = encodeOwnerSetup(setup);
  const preimage = new Uint8Array(tag.length * 2 + payload.length);
  preimage.set(tag, 0);
  preimage.set(tag, tag.length);
  preimage.set(payload, tag.length * 2);
  return sha256(preimage);
}

/**
 * True only when `signature` is the signer's over exactly this record. The
 * signer is the record's own owner key, except on a rotation: there the previous
 * revision's owner authorises the new one, so pass that key instead.
 */
export function verifyOwnerSetup(setup: OwnerSetup, signature: Uint8Array, signerXOnlyPublicKey: Uint8Array): boolean {
  if (signature.length !== 64 || signerXOnlyPublicKey.length !== 32) return false;
  try {
    return schnorr.verify(signature, ownerSetupDigest(setup), signerXOnlyPublicKey);
  } catch {
    return false;
  }
}
