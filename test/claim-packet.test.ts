import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeClaimPacket, decodeClaimPacket, CLAIM_PACKET_TYPE } from "../src/claim-packet.js";

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "hex"));

// covclaimd's own vectors (pkg/preimage/testdata, a4b378f20): pins the wire to
// their implementation rather than to our reading of packet.go.
interface Fixtures {
  claim_packet: {
    valid: { name: string; ciphertext: string; arkade_script: string; covclaimd_pub_key: string; expected_serialized: string }[];
    invalid_serialize: { name: string; ciphertext: string; arkade_script: string; covclaimd_pub_key: string; expected_error: string }[];
    invalid_deserialize: { name: string; data: string; expected_error: string }[];
  };
}
const fixtures: Fixtures = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/covclaimd-serialization-fixtures.json", import.meta.url)), "utf8"),
);

const packetOf = (f: { ciphertext: string; arkade_script: string; covclaimd_pub_key: string }) => ({
  ciphertext: bytes(f.ciphertext),
  arkadeScript: bytes(f.arkade_script),
  covclaimdPubkey: bytes(f.covclaimd_pub_key),
});

describe("encodeClaimPacket — covclaimd fixtures", () => {
  it.each(fixtures.claim_packet.valid)("serializes $name to covclaimd's bytes", (f) => {
    expect(hex(encodeClaimPacket(packetOf(f)))).toBe(f.expected_serialized);
  });

  it.each(fixtures.claim_packet.invalid_serialize)("refuses $name", (f) => {
    expect(() => encodeClaimPacket(packetOf(f))).toThrow(f.expected_error);
  });
});

describe("decodeClaimPacket — covclaimd fixtures", () => {
  it.each(fixtures.claim_packet.valid)("round-trips $name", (f) => {
    const out = decodeClaimPacket(bytes(f.expected_serialized));
    expect(hex(out.ciphertext)).toBe(f.ciphertext);
    expect(hex(out.arkadeScript)).toBe(f.arkade_script);
    expect(hex(out.covclaimdPubkey!)).toBe(f.covclaimd_pub_key);
  });

  it.each(fixtures.claim_packet.invalid_deserialize)("refuses $name", (f) => {
    expect(() => decodeClaimPacket(bytes(f.data))).toThrow(f.expected_error);
  });
});

describe("claim packet wire details", () => {
  const CIPHERTEXT = bytes("aabbccdd");
  const ARKADE_SCRIPT = bytes("5152");
  const PUBKEY = bytes("02" + "11".repeat(32));
  const packet = () => ({ ciphertext: CIPHERTEXT, arkadeScript: ARKADE_SCRIPT, covclaimdPubkey: PUBKEY });

  it("is the type covclaimd scans the tx stream for", () => {
    expect(CLAIM_PACKET_TYPE).toBe(0x04);
  });

  // Their README documents the filter as searching for exactly this needle.
  it("emits the 030021 needle covclaimd's extension filter selects on", () => {
    expect(hex(encodeClaimPacket(packet()))).toContain("030021" + hex(PUBKEY));
  });

  // Why covclaimd's filter uses `contains` rather than a fixed offset.
  it("decodes TLVs in any order", () => {
    const canonical = "010004aabbccdd" + "0200025152" + "030021" + hex(PUBKEY);
    const reversed = "030021" + hex(PUBKEY) + "0200025152" + "010004aabbccdd";
    expect(decodeClaimPacket(bytes(reversed))).toEqual(decodeClaimPacket(bytes(canonical)));
  });

  it("accepts the legacy two-TLV shape — 0x03 is optional to read", () => {
    const out = decodeClaimPacket(bytes("010004aabbccdd" + "0200025152"));
    expect(hex(out.ciphertext)).toBe(hex(CIPHERTEXT));
    expect(out.covclaimdPubkey).toBeUndefined();
  });

  it("lets a repeated type overwrite, as the Go parser does", () => {
    const out = decodeClaimPacket(bytes("010004aabbccdd" + "0100020102" + "0200025152"));
    expect(hex(out.ciphertext)).toBe("0102");
  });

  it("refuses a value too long for the 16-bit length header", () => {
    expect(() => encodeClaimPacket({ ...packet(), ciphertext: new Uint8Array(0x10000) })).toThrow(/TLV value too long/);
  });
});
