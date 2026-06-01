import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { deriveSessionId } from "../src/session-id.js";

describe("deriveSessionId", () => {
  it("is the first 32 hex chars of SHA-256(token bytes)", () => {
    const token = "ab".repeat(32);
    const expected = createHash("sha256").update(Buffer.from(token, "hex")).digest("hex").slice(0, 32);
    expect(deriveSessionId(token)).toBe(expected);
    expect(deriveSessionId(token)).toHaveLength(32);
  });
});
