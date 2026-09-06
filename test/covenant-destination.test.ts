import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { MultisigTapscript, VtxoScript } from "@arkade-os/sdk";
import { deriveCovenantDestination } from "../src/covenant-destination.js";

const xonly = (fill: number) => secp256k1.getPublicKey(new Uint8Array(32).fill(fill), true).subarray(1);
const serverPubkey = xonly(3);
const userPubkey = xonly(4);
const emulatorPubkey = secp256k1.getPublicKey(new Uint8Array(32).fill(5), true);
const staticAddress = new VtxoScript([
  MultisigTapscript.encode({ pubkeys: [xonly(9), serverPubkey] }).script,
]).address("tark", serverPubkey).encode();

const derive = (preimage: Uint8Array) =>
  deriveCovenantDestination({
    staticAddress,
    userPubkey,
    serverPubkey,
    emulatorPubkey,
    preimage,
    recoveryDelaySeconds: 4096,
  });

describe("deriveCovenantDestination", () => {
  // Golden values from the construction funded and swept on regtest, so a drift
  // here means the emulator would stop co-signing rather than a test going stale.
  it("reproduces the construction proven on-chain, byte for byte", () => {
    const d = derive(new Uint8Array(32).fill(7));

    expect(hex.encode(d.covenantScript)).toBe(
      "cd76d15188208ad35e9b86ff428ab4e125e27eb1bb05714dcb82a689ac1e40e736f4cfcdc12888cfcdc9a2",
    );
    expect(d.script).toBe("5120aaa385c70e9d339b3d1744ef2d409f9641a23c11370792b743ef2b485a71e1b1");
    expect(d.address).toBe(
      "tark1qpf3lesxsy69q0f8yvfnyf7gv7kglfkg83fhaxjyc0zmm0wtrl3n024rshrsa8fnnv73w38094qfl9jp5g7pzdc8j2m58metfpd8rcd37nqs45",
    );
  });

  it("gives every payment its own address while the covenant stays fixed", () => {
    const a = derive(new Uint8Array(32).fill(7));
    const b = derive(new Uint8Array(32).fill(8));

    expect(a.script).not.toBe(b.script);
    expect(hex.encode(a.covenantScript)).toBe(hex.encode(b.covenantScript));
  });

  it("pins the covenant to the user's static address, not the derived one", () => {
    const d = derive(new Uint8Array(32).fill(7));
    const staticKey = hex.encode(
      new VtxoScript([MultisigTapscript.encode({ pubkeys: [xonly(9), serverPubkey] }).script]).pkScript,
    ).slice(4);

    expect(hex.encode(d.covenantScript)).toContain(staticKey);
    expect(d.script).not.toBe(`5120${staticKey}`);
  });

  it("keeps the taptree decodable, since the sweep and covclaimd both need it", () => {
    const d = derive(new Uint8Array(32).fill(7));
    const decoded = VtxoScript.decode(d.tapTree);

    expect(decoded.scripts).toHaveLength(3);
    expect(hex.encode(decoded.pkScript)).toBe(d.script);
  });

  it("refuses a preimage that is not 32 bytes", () => {
    expect(() => derive(new Uint8Array(31).fill(7))).toThrow(/32 bytes/);
  });
});
