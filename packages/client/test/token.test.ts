import { describe, it, expect } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { deriveSessionToken, deriveSessionTokenWithSigner, deriveSessionId } from "../src/token.js";

describe("deriveSessionToken", () => {
  it("is sha256 of the deterministic ECDSA signature over the domain-bound digest", () => {
    const priv = "11".repeat(32);
    const digest = sha256(new TextEncoder().encode("lnurl-session:example.com"));
    const sig = secp256k1.sign(digest, hex.decode(priv), { prehash: false });
    expect(deriveSessionToken(priv, "example.com")).toBe(hex.encode(sha256(sig)));
  });

  // The whole point of the change. The token is a bearer credential that every
  // server both receives and persists, so a domain-independent one would let any
  // server the user touches authenticate as them everywhere else — including
  // repointing their Arkade receive identity, which redirects real funds.
  it("yields a different token per domain, so one server's token is useless at another", () => {
    const priv = "11".repeat(32);
    expect(deriveSessionToken(priv, "a.example")).not.toBe(deriveSessionToken(priv, "b.example"));
  });

  it("normalises the domain so case and padding cannot fork a user's identity", () => {
    const priv = "11".repeat(32);
    const canonical = deriveSessionToken(priv, "example.com");
    expect(deriveSessionToken(priv, "EXAMPLE.com")).toBe(canonical);
    expect(deriveSessionToken(priv, "  example.com  ")).toBe(canonical);
  });

  it("pins a known-answer vector so the derivation cannot drift silently", () => {
    expect(deriveSessionToken("11".repeat(32), "example.com")).toMatchInlineSnapshot(`"f97f58ec9694a416efa52e994e030647a42477afe00b9dcf59fac4f0171c7924"`);
  });

  // HMAC accepted any bytes as a key; ECDSA requires a valid scalar (1 <= k < n).
  // Failing loudly on a garbage key is better, but it IS a behaviour change.
  it("rejects a private key that is not a valid secp256k1 scalar", () => {
    expect(() => deriveSessionToken("00".repeat(32), "example.com")).toThrow(/invalid private key/i);
  });

  it("is deterministic and 64 hex chars", () => {
    const t = deriveSessionToken("ab".repeat(32), "example.com");
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveSessionToken("ab".repeat(32), "example.com")).toBe(t);
  });

  it("rejects a non-hex private key", () => {
    expect(() => deriveSessionToken("nope", "example.com")).toThrow();
  });

  it("refuses an empty domain rather than silently deriving an unbound token", () => {
    expect(() => deriveSessionToken("ab".repeat(32), "")).toThrow(/domain/);
    expect(() => deriveSessionToken("ab".repeat(32), "   ")).toThrow(/domain/);
  });
});

describe("deriveSessionTokenWithSigner", () => {
  // The whole point of offering both: a wallet can move between handing over a
  // key and holding one, without losing ownership of its addresses.
  it("produces exactly the token the key-based derivation does", async () => {
    const priv = "11".repeat(32);
    const signer = async (msg: Uint8Array): Promise<Uint8Array> =>
      secp256k1.sign(msg, hex.decode(priv), { prehash: false });
    await expect(deriveSessionTokenWithSigner(signer, "example.com"))
      .resolves.toBe(deriveSessionToken(priv, "example.com"));
  });

  it("never sees the private key", async () => {
    const priv = "11".repeat(32);
    const seen: Uint8Array[] = [];
    const signer = async (msg: Uint8Array): Promise<Uint8Array> => {
      seen.push(msg);
      return secp256k1.sign(msg, hex.decode(priv), { prehash: false });
    };
    await deriveSessionTokenWithSigner(signer, "example.com");
    // It is handed a digest of the domain string, nothing derived from the key.
    expect(seen[0]).toEqual(sha256(new TextEncoder().encode("lnurl-session:example.com")));
  });

  // schnorr is Identity.signMessage's DEFAULT and is randomised without an
  // explicit aux, which the SDK does not expose. Its signature is also 64 bytes,
  // exactly like compact ECDSA, so nothing about the bytes reveals the mistake —
  // it would simply mint a new token every call and orphan the address.
  it("rejects a non-deterministic signer instead of silently orphaning the address", async () => {
    let n = 0;
    const randomised = async (): Promise<Uint8Array> => {
      n += 1;
      return new Uint8Array(64).fill(n);
    };
    await expect(deriveSessionTokenWithSigner(randomised, "example.com"))
      .rejects.toThrow(/not deterministic/);
  });

  it("passes ecdsa to the signer so the caller cannot pick the wrong scheme", async () => {
    const types: string[] = [];
    const signer = async (msg: Uint8Array, type: "ecdsa"): Promise<Uint8Array> => {
      types.push(type);
      return secp256k1.sign(msg, hex.decode("11".repeat(32)), { prehash: false });
    };
    await deriveSessionTokenWithSigner(signer, "example.com");
    expect(types).toEqual(["ecdsa", "ecdsa"]);
  });

  it("is domain-bound like the key-based form", async () => {
    const priv = "11".repeat(32);
    const signer = async (msg: Uint8Array): Promise<Uint8Array> =>
      secp256k1.sign(msg, hex.decode(priv), { prehash: false });
    const a = await deriveSessionTokenWithSigner(signer, "a.example");
    const b = await deriveSessionTokenWithSigner(signer, "b.example");
    expect(a).not.toBe(b);
  });
});

describe("deriveSessionId", () => {
  it("is the first 32 hex chars of sha256 over the token BYTES", () => {
    const token = "cd".repeat(32);
    const expected = hex.encode(sha256(hex.decode(token))).slice(0, 32);
    expect(deriveSessionId(token)).toBe(expected);
    expect(deriveSessionId(token)).toHaveLength(32);
  });
});

