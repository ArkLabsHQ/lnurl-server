import { describe, expect, it } from "vitest";
import { checkedPreimage, randomEntropy, PREIMAGE_BYTES, type EntropyProvider } from "../src/entropy.js";

const fixed = (byte: number, length = PREIMAGE_BYTES): EntropyProvider => ({
  preimage: () => new Uint8Array(length).fill(byte),
});

describe("entropy provider", () => {
  it("defaults to 32 fresh bytes", () => {
    const a = checkedPreimage(randomEntropy);
    const b = checkedPreimage(randomEntropy);
    expect(a).toHaveLength(PREIMAGE_BYTES);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("takes what an injected provider returns", () => {
    expect(Buffer.from(checkedPreimage(fixed(7))).toString("hex")).toBe("07".repeat(PREIMAGE_BYTES));
  });

  // A covenant commits to HASH160(preimage) and a VHTLC to its hash, so a short
  // value is not a type error — it is an address nobody can spend.
  it("refuses a length other than 32", () => {
    expect(() => checkedPreimage(fixed(1, 31))).toThrow(/must return 32 bytes, got 31/);
    expect(() => checkedPreimage(fixed(1, 33))).toThrow(/must return 32 bytes/);
  });

  it("refuses a provider that returns the wrong type", () => {
    expect(() => checkedPreimage({ preimage: () => "deadbeef" as unknown as Uint8Array })).toThrow(/must return 32 bytes/);
  });
});
