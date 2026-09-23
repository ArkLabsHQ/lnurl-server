import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ArkAddress } from "@arkade-os/sdk";
import { decodeOwnerSetup, encodeOwnerSetup, ownerSetupDigest, verifyOwnerSetup, type OwnerSetup } from "../src/enclave/owner-setup.js";
import type { RailId } from "../src/rails.js";

const ownerKey = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const ownerPub = schnorr.getPublicKey(ownerKey);
const otherPub = schnorr.getPublicKey(Uint8Array.from({ length: 32 }, (_, i) => i + 9));
const DESTINATION = new ArkAddress(new Uint8Array(32).fill(2), new Uint8Array(32).fill(3), "tark").encode();
const OTHER_DESTINATION = new ArkAddress(new Uint8Array(32).fill(2), new Uint8Array(32).fill(4), "tark").encode();

const SETUP: OwnerSetup = {
  intent: "set",
  deployment: "lnurl-research",
  tenant: "wallet-co",
  network: "bitcoin",
  domain: "wallet.example",
  username: "alice",
  ownerPublicKey: bytesToHex(ownerPub),
  arkadeDestination: DESTINATION,
  claimPublicKey: "02" + "ab".repeat(32),
  rails: ["arkade", "offline-swap"],
  revision: 1,
};

const hexDigest = (setup: OwnerSetup): string => bytesToHex(ownerSetupDigest(setup));

function sign(setup: OwnerSetup): Uint8Array {
  return schnorr.sign(ownerSetupDigest(setup), ownerKey);
}

describe("owner-signed setup", () => {
  it("verifies the owner's signature over exactly this record", () => {
    expect(verifyOwnerSetup(SETUP, sign(SETUP), ownerPub)).toBe(true);
  });

  it("refuses a signature from another key, and a record the signature does not cover", () => {
    expect(verifyOwnerSetup(SETUP, sign(SETUP), otherPub)).toBe(false);
    expect(verifyOwnerSetup({ ...SETUP, arkadeDestination: OTHER_DESTINATION }, sign(SETUP), ownerPub)).toBe(false);
  });

  it.each([
    ["deployment", { deployment: "other" }],
    ["tenant", { tenant: "other" }],
    ["network", { network: "signet" }],
    ["domain", { domain: "other.example" }],
    ["username", { username: "bob" }],
    ["ownerPublicKey", { ownerPublicKey: bytesToHex(otherPub) }],
    ["arkadeDestination", { arkadeDestination: OTHER_DESTINATION }],
    ["claimPublicKey", { claimPublicKey: "03" + "ab".repeat(32) }],
    ["boardingAddress", { boardingAddress: "bc1qboarding" }],
    ["rails", { rails: ["arkade"] as RailId[] }],
  ] as const)("binds %s", (_field, change) => {
    expect(verifyOwnerSetup({ ...SETUP, ...change }, sign(SETUP), ownerPub)).toBe(false);
  });

  it("binds the revision and the hash it chains from", () => {
    const second: OwnerSetup = { ...SETUP, revision: 2, previousHash: "cd".repeat(32) };
    expect(hexDigest(second)).not.toBe(hexDigest({ ...second, previousHash: "ce".repeat(32) }));
    expect(hexDigest(second)).not.toBe(hexDigest({ ...second, revision: 3 }));
  });

  it("does not let a character move across a field boundary", () => {
    expect(hexDigest({ ...SETUP, domain: "ab", username: "c" })).not.toBe(hexDigest({ ...SETUP, domain: "a", username: "bc" }));
    expect(hexDigest({ ...SETUP, deployment: "ab", tenant: "c" })).not.toBe(hexDigest({ ...SETUP, deployment: "a", tenant: "bc" }));
  });

  it("treats rail order as part of the record", () => {
    expect(hexDigest(SETUP)).not.toBe(hexDigest({ ...SETUP, rails: ["offline-swap", "arkade"] }));
  });

  it("lets the previous owner authorise a rotation to a new key", () => {
    const nextKey = Uint8Array.from({ length: 32 }, (_, i) => i + 40);
    const rotation: OwnerSetup = {
      ...SETUP,
      ownerPublicKey: bytesToHex(schnorr.getPublicKey(nextKey)),
      revision: 2,
      previousHash: hexDigest(SETUP),
    };
    const signedByOldOwner = schnorr.sign(ownerSetupDigest(rotation), ownerKey);
    expect(verifyOwnerSetup(rotation, signedByOldOwner, ownerPub)).toBe(true);
    // The new key holds no authority over the record that grants it.
    expect(verifyOwnerSetup(rotation, signedByOldOwner, schnorr.getPublicKey(nextKey))).toBe(false);
  });

  it("is domain separated, so the digest is not a bare hash of its payload", () => {
    expect(hexDigest(SETUP)).not.toBe(bytesToHex(encodeOwnerSetup(SETUP)));
    expect(ownerSetupDigest(SETUP)).toHaveLength(32);
  });

  it("refuses identities that are not in their stored, lowercase form", () => {
    expect(() => encodeOwnerSetup({ ...SETUP, domain: "Wallet.example" })).toThrow(/domain must be non-empty and lowercase/);
    expect(() => encodeOwnerSetup({ ...SETUP, username: "Alice" })).toThrow(/username must be non-empty and lowercase/);
    expect(() => encodeOwnerSetup({ ...SETUP, tenant: "" })).toThrow(/tenant must not be empty/);
  });

  it("refuses a destination that is not a canonical Arkade address", () => {
    expect(() => encodeOwnerSetup({ ...SETUP, arkadeDestination: "tark1notanaddress" })).toThrow(/canonical Arkade address/);
    expect(() => encodeOwnerSetup({ ...SETUP, arkadeDestination: DESTINATION.toUpperCase() })).toThrow(/canonical Arkade address/);
  });

  it("refuses unknown or repeated rails", () => {
    expect(() => encodeOwnerSetup({ ...SETUP, rails: ["arkade", "bogus"] as unknown as RailId[] })).toThrow(/known rail ids/);
    expect(() => encodeOwnerSetup({ ...SETUP, rails: ["arkade", "arkade"] })).toThrow(/must not repeat/);
  });

  it("makes a first revision with a predecessor, or a later one without, unrepresentable", () => {
    expect(() => encodeOwnerSetup({ ...SETUP, previousHash: "cd".repeat(32) })).toThrow(/previousHash is required/);
    expect(() => encodeOwnerSetup({ ...SETUP, revision: 2 })).toThrow(/previousHash is required/);
    expect(() => encodeOwnerSetup({ ...SETUP, revision: 0 })).toThrow(/at least 1/);
  });

  it("refuses malformed keys, hashes and an empty boarding address", () => {
    expect(() => encodeOwnerSetup({ ...SETUP, claimPublicKey: "04" + "ab".repeat(32) })).toThrow(/compressed secp256k1/);
    expect(() => encodeOwnerSetup({ ...SETUP, ownerPublicKey: "ab".repeat(31) })).toThrow(/ownerPublicKey must be 32 bytes/);
    expect(() => encodeOwnerSetup({ ...SETUP, revision: 2, previousHash: "nothex" })).toThrow(/previousHash must be 32 bytes/);
    expect(() => encodeOwnerSetup({ ...SETUP, boardingAddress: "" })).toThrow(/omitted rather than empty/);
  });

  it("binds the intent, so a revocation can never pass as an update", () => {
    expect(hexDigest({ ...SETUP, intent: "revoke" })).not.toBe(hexDigest(SETUP));
  });

  it("decodes exactly what it encoded, and refuses anything else", () => {
    const later: OwnerSetup = { ...SETUP, boardingAddress: "tb1qboarding", revision: 2, previousHash: "cd".repeat(32) };
    for (const setup of [SETUP, later, { ...SETUP, intent: "revoke" } satisfies OwnerSetup]) {
      expect(decodeOwnerSetup(encodeOwnerSetup(setup))).toEqual(setup);
    }
    const bytes = encodeOwnerSetup(SETUP);
    expect(() => decodeOwnerSetup(Uint8Array.of(...bytes, 0))).toThrow(/trailing/);
    expect(() => decodeOwnerSetup(bytes.subarray(0, bytes.length - 1))).toThrow(/truncated/);
    expect(() => decodeOwnerSetup(Uint8Array.of(2, ...bytes.subarray(1)))).toThrow(/version/);
    expect(() => decodeOwnerSetup(Uint8Array.of(1, 3, ...bytes.subarray(2)))).toThrow(/intent/);
    const upper = Buffer.from(bytes);
    upper.write("W", upper.indexOf("wallet.example"), "latin1");
    expect(() => decodeOwnerSetup(upper)).toThrow(/lowercase/);
  });

  it("refuses keys that are not points on the curve", () => {
    const noPoint = "00".repeat(31) + "05";
    expect(() => encodeOwnerSetup({ ...SETUP, claimPublicKey: "02" + noPoint })).toThrow(/point on secp256k1/);
    expect(() => encodeOwnerSetup({ ...SETUP, ownerPublicKey: noPoint })).toThrow(/point on secp256k1/);
  });

  it("answers false rather than throwing for a malformed record or signature", () => {
    expect(verifyOwnerSetup({ ...SETUP, domain: "UPPER" }, sign(SETUP), ownerPub)).toBe(false);
    expect(verifyOwnerSetup(SETUP, new Uint8Array(63), ownerPub)).toBe(false);
    expect(verifyOwnerSetup(SETUP, sign(SETUP), new Uint8Array(33))).toBe(false);
  });
});
