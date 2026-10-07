/**
 * ClaimPacket TLV encoder, mirroring covclaimd `pkg/preimage/packet.go`.
 */

const TLV_CIPHERTEXT = 0x01;
const TLV_COVCLAIMD_PUBKEY = 0x03;

const COMPRESSED_PUBKEY_LEN = 33;

const encodeTlv = (type: number, value: Uint8Array): Uint8Array => {
  // The shift below wraps rather than throws: a short length, a full buffer.
  if (value.length > 0xffff) throw new Error(`TLV value too long: ${value.length} bytes`);
  const out = new Uint8Array(3 + value.length);
  out[0] = type;
  out[1] = (value.length >> 8) & 0xff;
  out[2] = value.length & 0xff;
  out.set(value, 3);
  return out;
};

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/**
 * The two TLVs only a client has. `0x02` is left to the solver, which builds the
 * covenant the script is committed in and so holds the only matching copy.
 */
export function encodeClientClaimPacket(input: { ciphertext: Uint8Array; covclaimdPubkey: Uint8Array }): Uint8Array {
  if (input.ciphertext.length === 0) throw new Error("ciphertext must not be empty");
  if (input.covclaimdPubkey.length !== COMPRESSED_PUBKEY_LEN) {
    throw new Error(`covclaimd_pub_key must be ${COMPRESSED_PUBKEY_LEN} bytes, got ${input.covclaimdPubkey.length}`);
  }
  return concat([encodeTlv(TLV_CIPHERTEXT, input.ciphertext), encodeTlv(TLV_COVCLAIMD_PUBKEY, input.covclaimdPubkey)]);
}
