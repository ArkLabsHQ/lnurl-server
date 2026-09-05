import { describe, it, expect } from "vitest";
import { encodeClaimPacket, decodeClaimPacket, CLAIM_PACKET_TYPE } from "../src/claim-packet.js";

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "hex"));

const CIPHERTEXT = bytes("aabbccdd");
const ARKADE_SCRIPT = bytes("5152");
const PUBKEY = bytes("02" + "11".repeat(32));

const packet = () => ({ ciphertext: CIPHERTEXT, arkadeScript: ARKADE_SCRIPT, covclaimdPubkey: PUBKEY });

describe("encodeClaimPacket", () => {
  it("lays out each TLV as type, 2-byte big-endian length, value", () => {
    expect(hex(encodeClaimPacket(packet()))).toBe(
      "010004aabbccdd" + "0200025152" + "030021" + "02" + "11".repeat(32),
    );
  });

  // covclaimd's CEL filter searches the packet body for this exact needle
  // (pkg/preimage/README.md), so matching it is their own statement of the
  // 0x03 header bytes rather than our reading of the encoder.
  it("emits the 030021 needle covclaimd's extension filter selects on", () => {
    expect(hex(encodeClaimPacket(packet()))).toContain("030021" + hex(PUBKEY));
  });

  it("is the type covclaimd scans the tx stream for", () => {
    expect(CLAIM_PACKET_TYPE).toBe(0x04);
  });

  it("refuses an empty ciphertext", () => {
    expect(() => encodeClaimPacket({ ...packet(), ciphertext: new Uint8Array() })).toThrow(/ciphertext/);
  });

  it("refuses an empty arkade_script", () => {
    expect(() => encodeClaimPacket({ ...packet(), arkadeScript: new Uint8Array() })).toThrow(/arkade_script/);
  });

  it("refuses a missing or wrong-length pubkey — the filter would drop the packet", () => {
    expect(() => encodeClaimPacket({ ciphertext: CIPHERTEXT, arkadeScript: ARKADE_SCRIPT })).toThrow(/33 bytes/);
    expect(() => encodeClaimPacket({ ...packet(), covclaimdPubkey: bytes("0211") })).toThrow(/33 bytes/);
  });
});

describe("decodeClaimPacket", () => {
  it("round-trips what encode produced", () => {
    const out = decodeClaimPacket(encodeClaimPacket(packet()));
    expect(hex(out.ciphertext)).toBe(hex(CIPHERTEXT));
    expect(hex(out.arkadeScript)).toBe(hex(ARKADE_SCRIPT));
    expect(hex(out.covclaimdPubkey!)).toBe(hex(PUBKEY));
  });

  it("accepts the legacy two-TLV shape — 0x03 is optional to read", () => {
    const out = decodeClaimPacket(bytes("010004aabbccdd" + "0200025152"));
    expect(hex(out.ciphertext)).toBe(hex(CIPHERTEXT));
    expect(out.covclaimdPubkey).toBeUndefined();
  });

  it("skips an unknown TLV type rather than refusing the packet", () => {
    const out = decodeClaimPacket(bytes("07000299ff" + "010004aabbccdd" + "0200025152"));
    expect(hex(out.ciphertext)).toBe(hex(CIPHERTEXT));
  });

  it("lets a repeated type overwrite, as the Go parser does", () => {
    const out = decodeClaimPacket(bytes("010004aabbccdd" + "0100020102" + "0200025152"));
    expect(hex(out.ciphertext)).toBe("0102");
  });

  it("requires the ciphertext and arkade_script TLVs", () => {
    expect(() => decodeClaimPacket(bytes("0200025152"))).toThrow(/ciphertext TLV \(0x01\)/);
    expect(() => decodeClaimPacket(bytes("010004aabbccdd"))).toThrow(/arkade_script TLV \(0x02\)/);
  });

  it("refuses a 0x03 that is not 33 bytes", () => {
    expect(() => decodeClaimPacket(bytes("010004aabbccdd" + "0200025152" + "0300020211"))).toThrow(
      /covclaimd_pub_key TLV \(0x03\) is 2 bytes/,
    );
  });

  it("refuses a truncated header and a truncated value", () => {
    expect(() => decodeClaimPacket(bytes("010004aabbccdd" + "0200025152" + "0300"))).toThrow(/type\+length header/);
    expect(() => decodeClaimPacket(bytes("010004aabb"))).toThrow(/wants 4 bytes, 2 left/);
  });
});
