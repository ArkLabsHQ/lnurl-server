import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;

export interface EncryptedToken {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

/** Encrypt a wallet token with AES-256-GCM. `key` must be 32 bytes. */
export function encryptToken(plaintext: string, key: Buffer): EncryptedToken {
  if (key.length !== 32) throw new Error("encryption key must be 32 bytes");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, iv, tag };
}

/** Decrypt a token previously produced by `encryptToken`. Throws on tamper/wrong key. */
export function decryptToken(enc: EncryptedToken, key: Buffer): string {
  if (key.length !== 32) throw new Error("encryption key must be 32 bytes");
  const decipher = createDecipheriv(ALGO, key, enc.iv);
  decipher.setAuthTag(enc.tag);
  return Buffer.concat([decipher.update(enc.ciphertext), decipher.final()]).toString("utf8");
}

/** One-way hash for API keys and claim codes (verify-only secrets). */
export function hashSecret(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}
