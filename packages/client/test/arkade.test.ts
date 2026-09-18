import { describe, it, expect, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { arkadeIdentityRequest, claimPublicKeyOf, deriveSessionTokenForIdentity, isArkadeAddress } from "../src/arkade.js";
import { deriveSessionToken, sessionTokenMessage } from "../src/token.js";
import { LnurlError } from "../src/errors.js";

const PRIVATE_KEY = "11".repeat(32);
const DOMAIN = "example.com";
const ARKADE_ADDRESS =
  "tark1qpf3lesxsy69q0f8yvfnyf7gv7kglfkg83fhaxjyc0zmm0wtrl3n024rshrsa8fnnv73w38094qfl9jp5g7pzdc8j2m58metfpd8rcd37nqs45";

/** Stands in for an `@arkade-os/sdk` Identity: RFC6979 ECDSA over the digest. */
const identity = {
  signMessage: async (message: Uint8Array, signatureType: "schnorr" | "ecdsa") => {
    if (signatureType !== "ecdsa") throw new Error(`unexpected signature type: ${signatureType}`);
    return secp256k1.sign(message, hex.decode(PRIVATE_KEY), { prehash: false });
  },
  compressedPublicKey: async () => secp256k1.getPublicKey(hex.decode(PRIVATE_KEY), true),
};

describe("isArkadeAddress", () => {
  it("rejects anything that does not decode", () => {
    expect(isArkadeAddress("not-an-address")).toBe(false);
    expect(isArkadeAddress("")).toBe(false);
    expect(isArkadeAddress("ark1qnonsense")).toBe(false);
  });
});

describe("deriveSessionTokenForIdentity", () => {
  // The whole point of the two derivations: a wallet can move between holding
  // raw key material and holding an Identity without losing its addresses.
  it("agrees with the raw-key derivation", async () => {
    await expect(deriveSessionTokenForIdentity(identity, DOMAIN)).resolves.toBe(deriveSessionToken(PRIVATE_KEY, DOMAIN));
  });

  it("signs with ecdsa, never the randomised schnorr default", async () => {
    const spy = vi.fn(identity.signMessage);
    await deriveSessionTokenForIdentity({ ...identity, signMessage: spy }, DOMAIN);
    expect(spy.mock.calls.every(([, type]) => type === "ecdsa")).toBe(true);
    expect(spy.mock.calls[0]?.[0]).toEqual(sessionTokenMessage(DOMAIN));
  });

  it("stays domain-bound", async () => {
    const here = await deriveSessionTokenForIdentity(identity, DOMAIN);
    const elsewhere = await deriveSessionTokenForIdentity(identity, "other.com");
    expect(here).not.toBe(elsewhere);
  });

  it("refuses a signer that is not deterministic", async () => {
    const randomised = {
      ...identity,
      signMessage: async () => secp256k1.sign(sessionTokenMessage(DOMAIN), secp256k1.utils.randomSecretKey(), { prehash: false }),
    };
    await expect(deriveSessionTokenForIdentity(randomised, DOMAIN)).rejects.toThrow(/not deterministic/);
  });
});

describe("claimPublicKeyOf", () => {
  it("returns the 66-hex-char compressed key the server validates", async () => {
    const key = await claimPublicKeyOf(identity);
    expect(key).toMatch(/^0[23][0-9a-f]{64}$/);
  });

  it("rejects a key that is not 33 bytes", async () => {
    const bad = { ...identity, compressedPublicKey: async () => new Uint8Array(32) };
    await expect(claimPublicKeyOf(bad)).rejects.toBeInstanceOf(LnurlError);
  });
});

describe("arkadeIdentityRequest", () => {
  it("rejects a malformed Arkade address before the wire", async () => {
    await expect(
      arkadeIdentityRequest({ identity, arkadeAddress: "nope", token: "tok", username: "alice" }),
    ).rejects.toThrow(/not a valid Arkade address/);
  });

  it("passes a boarding address through, and omits the key without one", async () => {
    const base = { identity, arkadeAddress: ARKADE_ADDRESS, token: "tok", username: "alice" };
    await expect(arkadeIdentityRequest({ ...base, boardingAddress: "bcrt1qboarding" })).resolves.toMatchObject({
      boardingAddress: "bcrt1qboarding",
    });
    expect("boardingAddress" in (await arkadeIdentityRequest(base))).toBe(false);
  });
});
