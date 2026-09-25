import { randomBytes } from "node:crypto";

/**
 * Where a per-payment secret comes from.
 *
 * One seam over the two places this service invents a preimage: the covenant
 * destination's sweep-leaf secret and the offline swap's HTLC secret. Both are
 * 32 bytes and both were `randomBytes` inline, which left a deployment that
 * wants its preimages to come from somewhere else — an HSM, a KDF, anything
 * reproducible — with nowhere to say so.
 *
 * The default is exactly the call it replaces, so wiring nothing keeps today's
 * behaviour byte for byte.
 */
export interface EntropyProvider {
  /** 32 bytes. Called once per payment; must not repeat a value. */
  preimage(): Uint8Array;
}

export const PREIMAGE_BYTES = 32;

/** The default: `crypto.randomBytes`, which is what both call sites used. */
export const randomEntropy: EntropyProvider = {
  preimage: () => randomBytes(PREIMAGE_BYTES),
};

/**
 * Guard the one property every caller depends on and none can check later: a
 * covenant commits to `HASH160(preimage)` and a VHTLC to its hash, so a short
 * or reused value is not a type error — it is an address nobody can spend.
 */
export function checkedPreimage(provider: EntropyProvider): Uint8Array {
  const value = provider.preimage();
  if (!(value instanceof Uint8Array) || value.length !== PREIMAGE_BYTES) {
    throw new Error(`entropy provider must return ${PREIMAGE_BYTES} bytes, got ${(value as Uint8Array)?.length}`);
  }
  return value;
}
