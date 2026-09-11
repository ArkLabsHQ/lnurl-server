import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { receiveVtxoScript, unilateralClaimDelay } from "../src/vendor/arkade-swap/rfq.js";
import { deserializeSelfClaim, serializeSelfClaim } from "../src/self-claim-codec.js";

describe("self-claim recovery codec", () => {
  it("round-trips the exact VHTLC v2 script", () => {
    const key = () => secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true).slice(1);
    const script = receiveVtxoScript({
      solverPubkey: key(),
      refundLocktime: 900_000,
      serverPubkey: key(),
      paymentHash: hex.encode(secp256k1.utils.randomSecretKey()),
      claimDelay: unilateralClaimDelay(86_400),
      emulatorPubkey: key(),
      solverRefundPkScript: new Uint8Array([0x51, 0x20, ...key()]),
      payoutPubkey: key(),
      payoutPkScript: new Uint8Array([0x51, 0x20, ...key()]),
    });

    const restored = deserializeSelfClaim(serializeSelfClaim(script, 4_999));
    expect(hex.encode(restored.script.encode())).toBe(hex.encode(script.encode()));
    expect(restored.expectedAmount).toBe(4_999);
  });

  it("rejects unsupported versions and malformed parameters", () => {
    expect(() => deserializeSelfClaim(JSON.stringify({ version: 2, expectedAmount: 1, params: {} }))).toThrow(/version/);
    expect(() => deserializeSelfClaim(JSON.stringify({ version: 1, expectedAmount: 0, params: {} }))).toThrow(/expectedAmount/);
  });
});
