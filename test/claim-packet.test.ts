import { describe, it, expect } from "vitest";
import { encodeClientClaimPacket } from "../src/covenant/claim-packet.js";

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "hex"));

describe("claim packet wire details", () => {
  const CIPHERTEXT = bytes("aabbccdd");
  const PUBKEY = bytes("02" + "11".repeat(32));

  it("encodes the client shape as 0x01 then 0x03, leaving 0x02 to the solver", () => {
    const out = encodeClientClaimPacket({ ciphertext: CIPHERTEXT, covclaimdPubkey: PUBKEY });
    expect(hex(out)).toBe("010004aabbccdd" + "030021" + hex(PUBKEY));
  });

  it("refuses a client packet without a 33-byte covclaimd key", () => {
    expect(() => encodeClientClaimPacket({ ciphertext: CIPHERTEXT, covclaimdPubkey: bytes("0211") })).toThrow(
      /33 bytes/,
    );
  });

  it("refuses a value too long for the 16-bit length header", () => {
    expect(() => encodeClientClaimPacket({ ciphertext: new Uint8Array(0x10000), covclaimdPubkey: PUBKEY })).toThrow(/TLV value too long/);
  });
});
