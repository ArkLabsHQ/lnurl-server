import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptToken, decryptToken, hashSecret } from "../src/crypto.js";

describe("crypto", () => {
  const token = "deadbeef".repeat(8); // 64 hex chars

  it("round-trips a token", () => {
    const key = randomBytes(32);
    const enc = encryptToken(token, key);
    expect(decryptToken(enc, key)).toBe(token);
  });

  it("produces a fresh IV each call", () => {
    const key = randomBytes(32);
    expect(encryptToken(token, key).iv.equals(encryptToken(token, key).iv)).toBe(false);
  });

  it("fails to decrypt with the wrong key", () => {
    const enc = encryptToken(token, randomBytes(32));
    expect(() => decryptToken(enc, randomBytes(32))).toThrow();
  });

  it("rejects non-32-byte keys", () => {
    expect(() => encryptToken("x", randomBytes(16))).toThrow(/32 bytes/);
  });

  it("hashSecret is deterministic and 32 bytes", () => {
    expect(hashSecret("k").equals(hashSecret("k"))).toBe(true);
    expect(hashSecret("k").length).toBe(32);
    expect(hashSecret("k").equals(hashSecret("j"))).toBe(false);
  });
});
