import { describe, it, expect, vi } from "vitest";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { base64urlnopad, hex } from "@scure/base";
import { ArkAddress } from "@arkade-os/sdk";
import {
  buildOwnerSetup, decodeOwnerSetup, deriveProtectedToken, encodeOwnerSetup, nextOwnerSetup, ownerSetupDigest,
  rotateOwnerSetup, signOwnerSetup, verifyFetchedSetup, type OwnerSetup,
} from "../src/setup.js";
import { deriveSessionTokenForIdentity } from "../src/arkade.js";
import { deriveSessionId } from "../src/token.js";
import { LnurlError } from "../src/errors.js";
import { arkadeLnurl } from "../src/wallet.js";
import type { FetchedOwnerSetup, LnurlClient } from "../src/index.js";

const signer = (privateKeyHex: string) => ({
  signMessage: async (message: Uint8Array, type: "schnorr" | "ecdsa") => type === "schnorr"
    ? schnorr.sign(message, hex.decode(privateKeyHex))
    : secp256k1.sign(message, hex.decode(privateKeyHex), { prehash: false }),
  compressedPublicKey: async () => secp256k1.getPublicKey(hex.decode(privateKeyHex), true),
});
const owner = signer("11".repeat(32));
const next = signer("22".repeat(32));
const xOnly = (key: string) => hex.encode(secp256k1.getPublicKey(hex.decode(key), true).subarray(1));
const DESTINATION = new ArkAddress(new Uint8Array(32).fill(2), new Uint8Array(32).fill(3), "tark").encode();
const PARAMS = {
  deployment: "lnurl-test", tenant: "wallet.example", network: "regtest", domain: "wallet.example", username: "alice",
  arkadeDestination: DESTINATION, claimPublicKey: "02" + "ab".repeat(32), rails: ["arkade", "offline-swap"] as const,
};

function fetched(setup: OwnerSetup, signature: Uint8Array, signerKey: string): FetchedOwnerSetup {
  return {
    domain: setup.domain, username: setup.username, revision: setup.revision, digest: hex.encode(ownerSetupDigest(setup)),
    previousDigest: setup.previousHash ?? null, intent: setup.revision === 1 ? "enroll" : "update",
    payload: base64urlnopad.encode(encodeOwnerSetup(setup)), signature: base64urlnopad.encode(signature), countersignature: null,
    signerPublicKey: signerKey, ownerPublicKey: setup.ownerPublicKey, acceptedAt: 1, state: "active", suspended: false,
    suspensionReason: null, deployment: setup.deployment, tenant: setup.tenant,
  };
}

describe("deriveProtectedToken", () => {
  it("derives a protected token distinct from the session token at the same domain", async () => {
    const token = await deriveProtectedToken(owner, "Wallet.Example");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await deriveProtectedToken(owner, "wallet.example")).toBe(token);
    const session = await deriveSessionTokenForIdentity(owner, "wallet.example");
    expect(token).not.toBe(session);
    expect(deriveSessionId(token)).not.toBe(deriveSessionId(session));
    expect(await deriveProtectedToken(owner, "other.example")).not.toBe(token);
  });
});

describe("owner setups", () => {
  it("builds, chains and rotates setups, each signature verifying under the key that must sign it", async () => {
    const first = await buildOwnerSetup(owner, PARAMS);
    expect(first).toMatchObject({ intent: "set", revision: 1, ownerPublicKey: xOnly("11".repeat(32)) });
    expect(first.previousHash).toBeUndefined();
    expect(decodeOwnerSetup(encodeOwnerSetup(first))).toEqual(first);
    const signed = await signOwnerSetup(owner, first);
    expect(schnorr.verify(signed.signature, ownerSetupDigest(first), hex.decode(first.ownerPublicKey))).toBe(true);

    const second = nextOwnerSetup(first, { rails: ["arkade", "onchain"], boardingAddress: "tb1qowner" });
    expect(second).toMatchObject({ revision: 2, previousHash: hex.encode(ownerSetupDigest(first)), ownerPublicKey: first.ownerPublicKey });

    const rotated = await rotateOwnerSetup(owner, next, second);
    expect(rotated.setup).toMatchObject({ revision: 3, ownerPublicKey: xOnly("22".repeat(32)) });
    expect(schnorr.verify(rotated.signature, ownerSetupDigest(rotated.setup), hex.decode(first.ownerPublicKey))).toBe(true);
    expect(schnorr.verify(rotated.countersignature!, ownerSetupDigest(rotated.setup), hex.decode(rotated.setup.ownerPublicKey))).toBe(true);
    expect(nextOwnerSetup(rotated.setup, { intent: "revoke" })).toMatchObject({ intent: "revoke", revision: 4 });
  });

  it("refuses a signer whose schnorr signature does not verify under its own key", async () => {
    const ecdsaOnly = { ...owner, signMessage: (m: Uint8Array) => owner.signMessage(m, "ecdsa") };
    await expect(signOwnerSetup(ecdsaOnly, await buildOwnerSetup(owner, PARAMS))).rejects.toThrow(LnurlError);
  });

  it("refuses what the server would refuse, before anything is signed", async () => {
    await expect(buildOwnerSetup(owner, { ...PARAMS, username: "Alice" })).rejects.toThrow(LnurlError);
    await expect(buildOwnerSetup(owner, { ...PARAMS, claimPublicKey: "02" + "00".repeat(31) + "05" })).rejects.toThrow(/point on secp256k1/);
    await expect(buildOwnerSetup(owner, { ...PARAMS, arkadeDestination: "tark1notanaddress" })).rejects.toThrow(/canonical Arkade address/);
    expect(() => decodeOwnerSetup(Uint8Array.of(...encodeOwnerSetup(nextOwnerSetup(fixture(), {})), 0))).toThrow(/trailing/);
  });

  it("verifies a fetched setup, and refuses one that was tampered with", async () => {
    const setup = await buildOwnerSetup(owner, PARAMS);
    const { signature } = await signOwnerSetup(owner, setup);
    const good = fetched(setup, signature, setup.ownerPublicKey);
    expect(verifyFetchedSetup(good, { signer: setup.ownerPublicKey })).toEqual(setup);

    const stranger = signer("33".repeat(32));
    const forged = fetched(setup, await stranger.signMessage(ownerSetupDigest(setup), "schnorr"), setup.ownerPublicKey);
    expect(() => verifyFetchedSetup(forged)).toThrow(/does not verify/);
    expect(() => verifyFetchedSetup({ ...good, digest: "00".repeat(32) })).toThrow(/digest/);
    expect(() => verifyFetchedSetup({ ...good, username: "bob" })).toThrow(/another record/);
    expect(() => verifyFetchedSetup(good, { signer: xOnly("33".repeat(32)) })).toThrow(/pinned/);
  });
});

describe("arkadeLnurl.claimProtected", () => {
  it("enrolls with the protected token, never the session token", async () => {
    const submitOwnerSetup = vi.fn(async () => ({ ok: true, applied: true }) as never);
    const client = { submitOwnerSetup } as unknown as LnurlClient;
    const lnurl = arkadeLnurl({
      identity: owner, arkadeAddress: DESTINATION, baseUrl: "https://wallet.example", client,
      protectedSetup: { deployment: "lnurl-test", network: "regtest" },
    });

    await lnurl.claimProtected("Alice", ["arkade"]);

    const [submission] = submitOwnerSetup.mock.calls[0] as unknown as [{ payload: Uint8Array; token: string }];
    expect(submission.token).toBe(await deriveProtectedToken(owner, "wallet.example"));
    expect(submission.token).toBe(await lnurl.protectedToken());
    expect(decodeOwnerSetup(submission.payload)).toMatchObject({
      username: "alice", tenant: "wallet.example", rails: ["arkade"], arkadeDestination: DESTINATION,
      claimPublicKey: hex.encode(await owner.compressedPublicKey()),
    });
  });

  it("needs the deployment and network it is enrolling into", async () => {
    const lnurl = arkadeLnurl({ identity: owner, arkadeAddress: DESTINATION, baseUrl: "https://wallet.example", client: {} as LnurlClient });
    await expect(lnurl.claimProtected("alice", ["arkade"])).rejects.toThrow(/protectedSetup/);
  });
});

function fixture(): OwnerSetup {
  return { ...PARAMS, intent: "set", ownerPublicKey: xOnly("11".repeat(32)), rails: ["arkade"], revision: 1 };
}
