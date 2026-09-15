import { describe, it, expect } from "vitest";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { deriveSessionToken, deriveSessionId } from "../src/token.js";

describe("deriveSessionToken", () => {
  it("matches the wallet's shipped derivation", () => {
    const priv = "11".repeat(32);
    const expected = hex.encode(hmac(sha256, hex.decode(priv), new TextEncoder().encode("lnurl-session")));
    expect(deriveSessionToken(priv)).toBe(expected);
  });

  it("pins a known-answer vector so the contract cannot drift silently", () => {
    // Recompute only if the wallet's deriveLnurlCredentials changes — which would be
    // a breaking change that orphans every registered address.
    expect(deriveSessionToken("00".repeat(32))).toMatchInlineSnapshot(`"c2f5a2c04fd121c495030edd3c7ea3449af7b3b8efeb39fbc382f4f7ba728782"`);
  });

  it("is deterministic and 64 hex chars", () => {
    const t = deriveSessionToken("ab".repeat(32));
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveSessionToken("ab".repeat(32))).toBe(t);
  });

  it("rejects a non-hex private key", () => {
    expect(() => deriveSessionToken("nope")).toThrow();
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

