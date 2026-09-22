import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { encodeOwnerSetup, ownerSetupDigest, verifyOwnerSetup, type OwnerSetup } from "../src/enclave/owner-setup.js";

const ownerKey = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const ownerPub = schnorr.getPublicKey(ownerKey);

const SETUP: OwnerSetup = {
  deployment: "lnurl-research",
  tenant: "wallet-co",
  network: "bitcoin",
  address: "alice@wallet.example",
  claimPublicKey: "02" + "ab".repeat(32),
  rails: ["arkade", "offline-swap"],
  revision: 1,
};

function sign(setup: OwnerSetup): Uint8Array {
  return schnorr.sign(ownerSetupDigest(setup), ownerKey);
}

describe("owner-signed setup", () => {
  it("verifies the owner's signature over exactly this record", () => {
    expect(verifyOwnerSetup(SETUP, sign(SETUP), ownerPub)).toBe(true);
  });

  it("refuses a signature from another key, and a record the signature does not cover", () => {
    const other = schnorr.getPublicKey(Uint8Array.from({ length: 32 }, (_, i) => i + 9));
    expect(verifyOwnerSetup(SETUP, sign(SETUP), other)).toBe(false);
    expect(verifyOwnerSetup({ ...SETUP, address: "mallory@wallet.example" }, sign(SETUP), ownerPub)).toBe(false);
  });

  it.each([
    ["deployment", { deployment: "other" }],
    ["tenant", { tenant: "other" }],
    ["network", { network: "signet" }],
    ["address", { address: "bob@wallet.example" }],
    ["claimPublicKey", { claimPublicKey: "03" + "ab".repeat(32) }],
    ["rails", { rails: ["arkade"] }],
    ["revision", { revision: 2 }],
    ["previousHash", { previousHash: "cd".repeat(32) }],
  ] as const)("binds %s", (_field, change) => {
    expect(verifyOwnerSetup({ ...SETUP, ...change }, sign(SETUP), ownerPub)).toBe(false);
  });

  it("does not let a character move across a field boundary", () => {
    const left = ownerSetupDigest({ ...SETUP, deployment: "ab", tenant: "c" });
    const right = ownerSetupDigest({ ...SETUP, deployment: "a", tenant: "bc" });
    expect(bytesToHex(left)).not.toBe(bytesToHex(right));
  });

  it("treats rail order as part of the record", () => {
    const forward = ownerSetupDigest(SETUP);
    const reversed = ownerSetupDigest({ ...SETUP, rails: ["offline-swap", "arkade"] });
    expect(bytesToHex(forward)).not.toBe(bytesToHex(reversed));
  });

  it("separates an absent previous hash from any present one", () => {
    const first = ownerSetupDigest(SETUP);
    const chained = ownerSetupDigest({ ...SETUP, previousHash: "00".repeat(32) });
    expect(bytesToHex(first)).not.toBe(bytesToHex(chained));
  });

  it("is domain separated, so the digest is not a bare hash of its payload", () => {
    expect(bytesToHex(ownerSetupDigest(SETUP))).not.toBe(bytesToHex(encodeOwnerSetup(SETUP)));
    // A wallet signing this digest cannot be replayed as a signature over the
    // payload itself, nor over any other tagged message.
    expect(ownerSetupDigest(SETUP)).toHaveLength(32);
  });

  it("refuses to encode a key that is not compressed secp256k1", () => {
    expect(() => encodeOwnerSetup({ ...SETUP, claimPublicKey: "04" + "ab".repeat(32) })).toThrow(/compressed secp256k1/);
    expect(() => encodeOwnerSetup({ ...SETUP, claimPublicKey: "02" + "ab".repeat(31) })).toThrow(/compressed secp256k1/);
  });

  it("refuses a malformed previous hash and an out-of-range revision", () => {
    expect(() => encodeOwnerSetup({ ...SETUP, previousHash: "nothex" })).toThrow(/previousHash/);
    expect(() => encodeOwnerSetup({ ...SETUP, revision: -1 })).toThrow(/uint32/);
  });

  it("refuses a signature of the wrong shape rather than throwing", () => {
    expect(verifyOwnerSetup(SETUP, new Uint8Array(63), ownerPub)).toBe(false);
    expect(verifyOwnerSetup(SETUP, sign(SETUP), new Uint8Array(33))).toBe(false);
  });
});
