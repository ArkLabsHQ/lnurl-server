import { describe, it, expect } from "vitest";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { deriveSessionToken, deriveSessionId } from "../src/token.js";

describe("deriveSessionToken", () => {
  it("binds the domain into the HMAC message", () => {
    const priv = "11".repeat(32);
    const expected = hex.encode(
      hmac(sha256, hex.decode(priv), new TextEncoder().encode("lnurl-session:example.com")),
    );
    expect(deriveSessionToken(priv, "example.com")).toBe(expected);
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
    expect(deriveSessionToken("00".repeat(32), "example.com")).toMatchInlineSnapshot(`"4d59257ade802166da73176b062f6a0c65da7707993d55dc8eb01c8c721547ea"`);
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

describe("deriveSessionId", () => {
  it("is the first 32 hex chars of sha256 over the token BYTES", () => {
    const token = "cd".repeat(32);
    const expected = hex.encode(sha256(hex.decode(token))).slice(0, 32);
    expect(deriveSessionId(token)).toBe(expected);
    expect(deriveSessionId(token)).toHaveLength(32);
  });
});

