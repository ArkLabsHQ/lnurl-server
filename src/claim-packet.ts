/**
 * ClaimPacket TLV codec, mirroring covclaimd `pkg/preimage/packet.go`. Not in
 * `src/vendor/arkade-swap/`, whose exit plan deletes that directory wholesale.
 */

/** Arkade extension packet type covclaimd scans the arkd tx stream for. */
export const CLAIM_PACKET_TYPE = 0x04;

const TLV_CIPHERTEXT = 0x01;
const TLV_ARKADE_SCRIPT = 0x02;
const TLV_COVCLAIMD_PUBKEY = 0x03;

const COMPRESSED_PUBKEY_LEN = 33;

export interface ClaimPacket {
  ciphertext: Uint8Array;
  arkadeScript: Uint8Array;
  /** Compressed secp256k1. Required to write; absent in the legacy two-TLV shape. */
  covclaimdPubkey?: Uint8Array;
}

const encodeTlv = (type: number, value: Uint8Array): Uint8Array => {
  const out = new Uint8Array(3 + value.length);
  out[0] = type;
  out[1] = (value.length >> 8) & 0xff;
  out[2] = value.length & 0xff;
  out.set(value, 3);
  return out;
};

/**
 * Requires the pubkey the parser treats as optional: covclaimd's CEL filter
 * selects on that TLV, so the two-TLV shape is what a live filter would drop.
 */
export function encodeClaimPacket(packet: ClaimPacket): Uint8Array {
  if (packet.ciphertext.length === 0) throw new Error("ciphertext must not be empty");
  if (packet.arkadeScript.length === 0) throw new Error("arkade_script must not be empty");
  if (packet.covclaimdPubkey?.length !== COMPRESSED_PUBKEY_LEN) {
    throw new Error(
      `covclaimd_pub_key must be ${COMPRESSED_PUBKEY_LEN} bytes, got ${packet.covclaimdPubkey?.length ?? 0}`,
    );
  }
  const parts = [
    encodeTlv(TLV_CIPHERTEXT, packet.ciphertext),
    encodeTlv(TLV_ARKADE_SCRIPT, packet.arkadeScript),
    encodeTlv(TLV_COVCLAIMD_PUBKEY, packet.covclaimdPubkey),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Transcribed from `DeserializeClaim`: unknown TLV types are skipped rather
 * than refused, and a repeated type overwrites. Both deliberate there.
 */
export function decodeClaimPacket(data: Uint8Array): ClaimPacket {
  let ciphertext: Uint8Array | undefined;
  let arkadeScript: Uint8Array | undefined;
  let covclaimdPubkey: Uint8Array | undefined;

  let offset = 0;
  while (offset < data.length) {
    if (offset + 3 > data.length) {
      throw new Error("truncated TLV: not enough bytes for type+length header");
    }
    const type = data[offset];
    const length = (data[offset + 1] << 8) | data[offset + 2];
    offset += 3;
    if (offset + length > data.length) {
      const hex = type.toString(16).padStart(2, "0");
      throw new Error(`truncated TLV: type 0x${hex} wants ${length} bytes, ${data.length - offset} left`);
    }
    const value = data.slice(offset, offset + length);
    offset += length;

    if (type === TLV_CIPHERTEXT) ciphertext = value;
    else if (type === TLV_ARKADE_SCRIPT) arkadeScript = value;
    else if (type === TLV_COVCLAIMD_PUBKEY) {
      if (value.length !== COMPRESSED_PUBKEY_LEN) {
        throw new Error(`covclaimd_pub_key TLV (0x03) is ${value.length} bytes, want ${COMPRESSED_PUBKEY_LEN}`);
      }
      covclaimdPubkey = value;
    }
  }

  if (!ciphertext) throw new Error("missing ciphertext TLV (0x01)");
  if (!arkadeScript) throw new Error("missing arkade_script TLV (0x02)");
  return { ciphertext, arkadeScript, covclaimdPubkey };
}
