import { describe, it, expect } from "vitest";
import { hkdfSync, createDecipheriv } from "node:crypto";
import { base64, hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sealClaimPacket } from "../src/vendor/arkade-swap/claimPacket.js";

// Cross-implementation check: the vendored sealClaimPacket must produce blobs that
// covclaimd's pkg/preimage/crypto.go Decrypt accepts. This mirror is written directly
// from the Go source: ECDH x-coordinate (32 bytes) -> HKDF-SHA256(salt=ephPub,
// info="covclaimd/preimage/v1") -> AES-256-GCM with ephPub as AAD; wire layout
// ephPub(33) | nonce(12) | ciphertext+tag(16), base64 at the API boundary.
// (Upstream additionally verified this construction against a live daemon —
// arkade-os/intent-solver test/e2e/support/claimPacket.ts documents the exact
// negative space, and receiveLightningEdges.e2e settled on a real covclaimd claim.)
function covclaimdDecrypt(recipientPriv: Uint8Array, b64: string): Uint8Array {
  const blob = base64.decode(b64);
  const ephPub = blob.subarray(0, 33);
  const nonce = blob.subarray(33, 45);
  const ct = blob.subarray(45);
  const shared = secp256k1.getSharedSecret(recipientPriv, ephPub, true).subarray(1);
  const symKey = Buffer.from(hkdfSync("sha256", shared, Buffer.from(ephPub), "covclaimd/preimage/v1", 32));
  const decipher = createDecipheriv("aes-256-gcm", symKey, nonce);
  decipher.setAAD(Buffer.from(ephPub));
  decipher.setAuthTag(ct.subarray(-16));
  return new Uint8Array(Buffer.concat([decipher.update(ct.subarray(0, -16)), decipher.final()]));
}

describe("sealClaimPacket (vendored) vs covclaimd's wire scheme", () => {
  const covPriv = secp256k1.utils.randomSecretKey();
  const covPub = secp256k1.getPublicKey(covPriv, true);

  it("round-trips a preimage through the covclaimd decryption scheme", async () => {
    const preimage = secp256k1.utils.randomSecretKey(); // 32 random bytes
    const { ciphertext } = await sealClaimPacket({ preimage, covclaimdPubkey: covPub });
    expect(covclaimdDecrypt(covPriv, ciphertext)).toEqual(preimage);
  });

  it("fails authentication on any tampered ciphertext byte (AAD + tag bound)", async () => {
    const preimage = secp256k1.utils.randomSecretKey();
    const { ciphertext } = await sealClaimPacket({ preimage, covclaimdPubkey: covPub });
    const blob = base64.decode(ciphertext);
    blob[40] ^= 1; // inside the nonce+ciphertext region (any AEAD-covered byte)
    expect(() => covclaimdDecrypt(covPriv, base64.encode(blob))).toThrow();
  });

  it("carries a parseable compressed ephemeral key as the wire prefix", async () => {
    const { ciphertext } = await sealClaimPacket({ preimage: new Uint8Array(32), covclaimdPubkey: covPub });
    const blob = base64.decode(ciphertext);
    expect(blob.length).toBe(33 + 12 + 32 + 16);
    expect(() => secp256k1.Point.fromHex(hex.encode(blob.subarray(0, 33)))).not.toThrow();
  });
});
