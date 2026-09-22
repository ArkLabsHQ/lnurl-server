import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

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
  /** LUD-16 address this authorises, `user@domain`. */
  address: string;
  /** Compressed secp256k1, 33 bytes hex. */
  claimPublicKey: string;
  /** Rails the owner permits, in the order given; order is part of the record. */
  rails: readonly string[];
  revision: number;
  /** Digest of the revision this supersedes; absent only for the first. */
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

function u32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error("owner setup revision must be a uint32");
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

function hex32(value: string, what: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`owner setup ${what} must be 32 bytes of lowercase hex`);
  return Uint8Array.from(value.match(/../g)!.map((b) => parseInt(b, 16)));
}

/**
 * Every field is length-prefixed so no two different records can encode to the
 * same bytes — concatenation alone would let a character move across a boundary
 * and leave the digest unchanged.
 */
export function encodeOwnerSetup(setup: OwnerSetup): Uint8Array {
  if (!/^0[23][0-9a-f]{64}$/.test(setup.claimPublicKey)) {
    throw new Error("owner setup claimPublicKey must be a compressed secp256k1 key");
  }
  if (setup.rails.length > MAX_FIELD) throw new Error("owner setup lists too many rails");

  const railCount = new Uint8Array(2);
  new DataView(railCount.buffer).setUint16(0, setup.rails.length);

  const parts: Uint8Array[] = [
    Uint8Array.of(1),
    lengthPrefixed(setup.deployment),
    lengthPrefixed(setup.tenant),
    lengthPrefixed(setup.network),
    lengthPrefixed(setup.address),
    lengthPrefixed(setup.claimPublicKey),
    railCount,
    ...setup.rails.map(lengthPrefixed),
    u32(setup.revision),
    setup.previousHash === undefined ? Uint8Array.of(0) : Uint8Array.of(1),
    ...(setup.previousHash === undefined ? [] : [hex32(setup.previousHash, "previousHash")]),
  ];

  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
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

/** True only when `signature` is the owner's over exactly this record. */
export function verifyOwnerSetup(setup: OwnerSetup, signature: Uint8Array, ownerXOnlyPublicKey: Uint8Array): boolean {
  if (signature.length !== 64 || ownerXOnlyPublicKey.length !== 32) return false;
  try {
    return schnorr.verify(signature, ownerSetupDigest(setup), ownerXOnlyPublicKey);
  } catch {
    return false;
  }
}
