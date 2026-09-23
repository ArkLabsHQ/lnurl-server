import { ArkAddress } from "@arkade-os/sdk";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64urlnopad, hex } from "@scure/base";
import type { ArkadeSigner } from "./arkade.js";
import { LnurlError } from "./errors.js";
import type { FetchedOwnerSetup } from "./owner-setup-api.js";
import { deriveProtectedTokenWithSigner } from "./token.js";

// The server's encoding (src/enclave/owner-setup.ts) byte for byte, checks included: the
// server stores exactly the bytes the owner signs, so the two may never disagree.
export const OWNER_SETUP_TAG = "lnurl.enclave.setup.v1";
export const OWNER_SETUP_VERSION = 1;
const INTENTS = { set: 1, revoke: 2 } as const;
export type OwnerSetupIntent = keyof typeof INTENTS;
const RAIL_IDS = ["interactive-lightning", "offline-swap", "arkade", "covenant", "onchain"] as const;
export type OwnerSetupRail = (typeof RAIL_IDS)[number];
const MAX_FIELD = 65_535;

export interface OwnerSetup {
  intent: OwnerSetupIntent;
  deployment: string;
  tenant: string;
  network: string;
  domain: string;
  username: string;
  /** BIP340 x-only key, 32 bytes hex. */
  ownerPublicKey: string;
  arkadeDestination: string;
  /** Compressed secp256k1, 33 bytes hex. */
  claimPublicKey: string;
  boardingAddress?: string;
  rails: readonly OwnerSetupRail[];
  revision: number;
  /** ownerSetupDigest of the previous revision, hex; absent only on revision 1. */
  previousHash?: string;
}

export type OwnerSetupParams = Omit<OwnerSetup, "intent" | "ownerPublicKey" | "revision" | "previousHash">;

export interface SignedOwnerSetup {
  setup: OwnerSetup;
  payload: Uint8Array;
  signature: Uint8Array;
  countersignature?: Uint8Array;
}

const fail = (message: string): never => { throw new LnurlError(message); };

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

function lengthPrefixed(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > MAX_FIELD) fail("owner setup field is too long to encode");
  return concat([Uint8Array.of(bytes.length >> 8, bytes.length & 0xff), bytes]);
}

const u16 = (value: number) => Uint8Array.of(value >> 8, value & 0xff);
const u32 = (value: number) => Uint8Array.of(value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
const optional = (part: Uint8Array | undefined): Uint8Array[] => (part === undefined ? [Uint8Array.of(0)] : [Uint8Array.of(1), part]);

function fixedHex(value: string, bytes: number, what: string): Uint8Array {
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)) fail(`owner setup ${what} must be ${bytes} bytes of lowercase hex`);
  return hex.decode(value);
}

function isCurvePoint(compressedHex: string): boolean {
  try {
    secp256k1.Point.fromHex(compressedHex);
    return true;
  } catch {
    return false;
  }
}

function isCanonicalArkAddress(value: string): boolean {
  try {
    return ArkAddress.decode(value).encode() === value;
  } catch {
    return false;
  }
}

function assertValid(setup: OwnerSetup): void {
  if (!Object.hasOwn(INTENTS, setup.intent)) fail("owner setup intent must be set or revoke");
  for (const [name, value] of [["deployment", setup.deployment], ["tenant", setup.tenant], ["network", setup.network]] as const) {
    if (!value) fail(`owner setup ${name} must not be empty`);
  }
  for (const [name, value] of [["domain", setup.domain], ["username", setup.username]] as const) {
    if (!value || value !== value.toLowerCase()) fail(`owner setup ${name} must be non-empty and lowercase, as stored`);
  }
  if (!isCanonicalArkAddress(setup.arkadeDestination)) fail("owner setup arkadeDestination must be a canonical Arkade address");
  if (!/^0[23][0-9a-f]{64}$/.test(setup.claimPublicKey)) fail("owner setup claimPublicKey must be a compressed secp256k1 key");
  if (!isCurvePoint(setup.claimPublicKey)) fail("owner setup claimPublicKey must be a point on secp256k1");
  if (/^[0-9a-f]{64}$/.test(setup.ownerPublicKey) && !isCurvePoint(`02${setup.ownerPublicKey}`)) {
    fail("owner setup ownerPublicKey must be the x coordinate of a point on secp256k1");
  }
  if (setup.boardingAddress === "") fail("owner setup boardingAddress must be omitted rather than empty");
  if (!setup.rails.every((r) => (RAIL_IDS as readonly string[]).includes(r))) fail("owner setup rails must be known rail ids");
  if (new Set(setup.rails).size !== setup.rails.length) fail("owner setup rails must not repeat");
  if (!Number.isInteger(setup.revision) || setup.revision < 1 || setup.revision > 0xffff_ffff) fail("owner setup revision must be a uint32 of at least 1");
  if ((setup.revision === 1) !== (setup.previousHash === undefined)) {
    fail("owner setup previousHash is required after the first revision and forbidden on it");
  }
}

export function encodeOwnerSetup(setup: OwnerSetup): Uint8Array {
  assertValid(setup);
  return concat([
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
  ]);
}

export function decodeOwnerSetup(bytes: Uint8Array): OwnerSetup {
  let at = 0;
  const take = (n: number): Uint8Array => {
    if (bytes.length - at < n) fail("owner setup payload is truncated");
    return bytes.subarray(at, (at += n));
  };
  const u8 = (): number => take(1)[0]!;
  const read16 = (): number => { const b = take(2); return (b[0]! << 8) | b[1]!; };
  const read32 = (): number => { const b = take(4); return ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0; };
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const text = (): string => {
    try {
      return utf8.decode(take(read16()));
    } catch (error) {
      if (error instanceof LnurlError) throw error;
      return fail("owner setup payload holds invalid UTF-8");
    }
  };
  const present = <T>(read: () => T): T | undefined => {
    const flag = u8();
    if (flag > 1) fail("owner setup payload has an invalid presence byte");
    return flag === 1 ? read() : undefined;
  };

  const version = u8();
  if (version !== OWNER_SETUP_VERSION) fail(`owner setup version ${version} is not ${OWNER_SETUP_VERSION}`);
  const intentByte = u8();
  const intent = (Object.keys(INTENTS) as OwnerSetupIntent[]).find((k) => INTENTS[k] === intentByte) ?? fail(`owner setup intent ${intentByte} is unknown`);
  const setup: OwnerSetup = {
    intent,
    deployment: text(),
    tenant: text(),
    network: text(),
    domain: text(),
    username: text(),
    ownerPublicKey: hex.encode(take(32)),
    arkadeDestination: text(),
    claimPublicKey: hex.encode(take(33)),
    boardingAddress: present(text),
    rails: Array.from({ length: read16() }, () => text()) as OwnerSetupRail[],
    revision: read32(),
    previousHash: present(() => hex.encode(take(32))),
  };
  if (at !== bytes.length) fail("owner setup payload has trailing bytes");
  const canonical = encodeOwnerSetup(setup);
  if (canonical.length !== bytes.length || canonical.some((b, i) => b !== bytes[i])) fail("owner setup payload is not canonical");
  if (setup.boardingAddress === undefined) delete setup.boardingAddress;
  if (setup.previousHash === undefined) delete setup.previousHash;
  return setup;
}

export function ownerSetupDigest(setup: OwnerSetup): Uint8Array {
  const tag = sha256(new TextEncoder().encode(OWNER_SETUP_TAG));
  return sha256(concat([tag, tag, encodeOwnerSetup(setup)]));
}

export async function ownerPublicKeyOf(identity: ArkadeSigner): Promise<string> {
  const key = await identity.compressedPublicKey();
  if (key.length !== 33) fail(`expected a 33-byte compressed public key, got ${key.length} bytes`);
  return hex.encode(key.subarray(1));
}

/** Revision 1, owned by `identity`. */
export async function buildOwnerSetup(identity: ArkadeSigner, params: OwnerSetupParams): Promise<OwnerSetup> {
  const setup: OwnerSetup = { ...params, intent: "set", ownerPublicKey: await ownerPublicKeyOf(identity), revision: 1 };
  encodeOwnerSetup(setup);
  return setup;
}

/** The revision after `previous`, chained to it. Only the committed owner may sign it. */
export function nextOwnerSetup(previous: OwnerSetup, changes: Partial<Omit<OwnerSetup, "revision" | "previousHash">> = {}): OwnerSetup {
  const setup: OwnerSetup = { ...previous, ...changes, revision: previous.revision + 1, previousHash: hex.encode(ownerSetupDigest(previous)) };
  if (setup.boardingAddress === undefined) delete setup.boardingAddress;
  encodeOwnerSetup(setup);
  return setup;
}

export async function signOwnerSetup(identity: ArkadeSigner, setup: OwnerSetup): Promise<SignedOwnerSetup> {
  const digest = ownerSetupDigest(setup);
  const signature = await identity.signMessage(digest, "schnorr");
  // A signer answering "schnorr" with anything else would only be caught as a 401 later.
  if (!schnorr.verify(signature, digest, hex.decode(await ownerPublicKeyOf(identity)))) {
    fail("the signer's schnorr signature does not verify under its own key");
  }
  return { setup, payload: encodeOwnerSetup(setup), signature };
}

/** `current` signs the revision granting `next`'s key, and `next` countersigns it. */
export async function rotateOwnerSetup(
  current: ArkadeSigner, next: ArkadeSigner, previous: OwnerSetup, changes: Partial<OwnerSetupParams> = {},
): Promise<SignedOwnerSetup> {
  const setup = nextOwnerSetup(previous, { ...changes, ownerPublicKey: await ownerPublicKeyOf(next) });
  const signed = await signOwnerSetup(current, setup);
  return { ...signed, countersignature: (await signOwnerSetup(next, setup)).signature };
}

/**
 * The decoded setup, once the record is consistent with itself: its bytes, digest, name,
 * granted key and signature(s) all agree. That alone proves nothing about who signed it;
 * pass `signer` (an x-only key you already trust) to require it.
 */
export function verifyFetchedSetup(fetched: FetchedOwnerSetup, opts: { signer?: string } = {}): OwnerSetup {
  const reject = (why: string): never => fail(`fetched owner setup ${why}`);
  let payload: Uint8Array;
  let signature: Uint8Array;
  try {
    payload = base64urlnopad.decode(fetched.payload);
    signature = base64urlnopad.decode(fetched.signature);
  } catch {
    return reject("is not base64url");
  }
  const setup = decodeOwnerSetup(payload);
  const digest = ownerSetupDigest(setup);
  if (hex.encode(digest) !== fetched.digest) reject("does not match its digest");
  if (setup.domain !== fetched.domain || setup.username !== fetched.username || setup.revision !== fetched.revision) reject("names another record");
  if ((setup.previousHash ?? null) !== fetched.previousDigest) reject("links to another revision");
  if (setup.ownerPublicKey !== fetched.ownerPublicKey) reject("grants another key");
  if (setup.revision === 1 && fetched.signerPublicKey !== setup.ownerPublicKey) reject("is an enrollment its own key did not sign");
  if (fetched.signerPublicKey !== setup.ownerPublicKey && fetched.countersignature === null) reject("rotates without the new key's countersignature");
  if (opts.signer !== undefined && fetched.signerPublicKey !== opts.signer) reject("is not signed by the pinned key");
  const verifies = (sig: Uint8Array, key: string) => {
    try {
      return schnorr.verify(sig, digest, hex.decode(key));
    } catch {
      return false;
    }
  };
  if (!verifies(signature, fetched.signerPublicKey)) reject("signature does not verify");
  if (fetched.countersignature !== null && !verifies(base64urlnopad.decode(fetched.countersignature), setup.ownerPublicKey)) {
    reject("countersignature does not verify");
  }
  return setup;
}

export function deriveProtectedToken(identity: ArkadeSigner, domain: string): Promise<string> {
  return deriveProtectedTokenWithSigner((message) => identity.signMessage(message, "ecdsa"), domain);
}
