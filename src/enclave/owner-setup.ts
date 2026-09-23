import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ArkAddress } from "@arkade-os/sdk";
import { isRailId, type RailId } from "../rails.js";

/**
 * Canonical encoding for an owner-signed receive setup. The client mirrors it
 * byte for byte (packages/client/src/setup.ts), and
 * test/client-owner-setup.test.ts holds the two together.
 *
 * Signed with schnorr rather than the ECDSA the session token pins. That pin
 * exists because a token derived from a signature has to be deterministic; a
 * stored signature does not, so the SDK's default applies.
 */
export interface OwnerSetup {
  /** A revocation is a signed revision like any other, so it needs its own meaning. */
  intent: OwnerSetupIntent;
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
  /** ownerSetupDigest of the previous revision, hex. */
  previousHash?: string;
}

export const OWNER_SETUP_TAG = "lnurl.enclave.setup.v1";
export const OWNER_SETUP_VERSION = 1;
const INTENTS = { set: 1, revoke: 2 } as const;
export type OwnerSetupIntent = keyof typeof INTENTS;
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

function isCurvePoint(compressedHex: string): boolean {
  try {
    secp256k1.Point.fromHex(compressedHex);
    return true;
  } catch {
    return false;
  }
}

function assertValid(setup: OwnerSetup): void {
  if (!Object.hasOwn(INTENTS, setup.intent)) throw new Error("owner setup intent must be set or revoke");
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
  // A shape-valid key off the curve could still be rotated to, bricking an identity
  // that nobody may reassign.
  if (!isCurvePoint(setup.claimPublicKey)) throw new Error("owner setup claimPublicKey must be a point on secp256k1");
  if (/^[0-9a-f]{64}$/.test(setup.ownerPublicKey) && !isCurvePoint(`02${setup.ownerPublicKey}`)) {
    throw new Error("owner setup ownerPublicKey must be the x coordinate of a point on secp256k1");
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
    Uint8Array.of(OWNER_SETUP_VERSION, INTENTS[setup.intent]),
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

/** The record in exactly these bytes, or a throw. What is stored is what the owner
 *  signed, so anything the encoder would not produce byte for byte is refused. */
export function decodeOwnerSetup(bytes: Uint8Array): OwnerSetup {
  let at = 0;
  const take = (n: number): Uint8Array => {
    if (bytes.length - at < n) throw new Error("owner setup payload is truncated");
    const out = bytes.subarray(at, at + n);
    at += n;
    return out;
  };
  const u8 = (): number => take(1)[0]!;
  const u16 = (): number => { const b = take(2); return (b[0]! << 8) | b[1]!; };
  const u32 = (): number => { const b = take(4); return new DataView(b.buffer, b.byteOffset, 4).getUint32(0); };
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const text = (): string => utf8.decode(take(u16()));
  const optional = <T>(read: () => T): T | undefined => {
    const flag = u8();
    if (flag > 1) throw new Error("owner setup payload has an invalid presence byte");
    return flag === 1 ? read() : undefined;
  };

  const version = u8();
  if (version !== OWNER_SETUP_VERSION) throw new Error(`owner setup version ${version} is not ${OWNER_SETUP_VERSION}`);
  const intentByte = u8();
  const intent = (Object.keys(INTENTS) as OwnerSetupIntent[]).find((k) => INTENTS[k] === intentByte);
  if (!intent) throw new Error(`owner setup intent ${intentByte} is unknown`);
  const setup: OwnerSetup = {
    intent,
    deployment: text(),
    tenant: text(),
    network: text(),
    domain: text(),
    username: text(),
    ownerPublicKey: bytesToHex(take(32)),
    arkadeDestination: text(),
    claimPublicKey: bytesToHex(take(33)),
    boardingAddress: optional(text),
    rails: Array.from({ length: u16() }, () => text()) as RailId[],
    revision: u32(),
    previousHash: optional(() => bytesToHex(take(32))),
  };
  if (at !== bytes.length) throw new Error("owner setup payload has trailing bytes");
  const canonical = encodeOwnerSetup(setup);
  if (canonical.length !== bytes.length || canonical.some((b, i) => b !== bytes[i])) {
    throw new Error("owner setup payload is not canonical");
  }
  return setup;
}

/** BIP340-style tagged hash, so this digest cannot be a valid signature over
 *  anything else the owner's key is ever asked to sign. */
export function ownerSetupDigest(setup: OwnerSetup): Uint8Array {
  const tag = sha256(new TextEncoder().encode(OWNER_SETUP_TAG));
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
