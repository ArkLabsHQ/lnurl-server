// Per-payment destinations for the Arkade rail: the script is the identifier, so
// concurrent payments need no guessing from amount and arrival time.
//
//   leaf 0  condition(H(P)) + operator + covenant cosigner  sweep, pinned
//   leaf 1  user + operator                                 collaborative
//   leaf 2  user alone after CSV                            unilateral recovery
//
// Only leaf 0 carries H(P): a fresh preimage moves the address, the covenant bytes
// stay fixed, and the user's two recovery paths need neither P nor this server.

import { hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import {
  arkade,
  ArkAddress,
  CSVMultisigTapscript,
  ConditionMultisigTapscript,
  MultisigTapscript,
  VtxoScript,
} from "@arkade-os/sdk";

/** `HASH160 <hash20> EQUAL` — the condition the sweep leaf gates on. */
const preimageCondition = (hash20: Uint8Array): Uint8Array =>
  arkade.ArkadeScript.encode(["HASH160", hash20, "EQUAL"] as Parameters<typeof arkade.ArkadeScript.encode>[0]);

/** Re-emitted, not imported: the emulator co-signs only a covenant hashing to the
 *  key baked into the leaf, so these bytes must match its own exactly. */
const enforcePayTo = (destinationPkScript: Uint8Array): Uint8Array => {
  if (destinationPkScript.length !== 34 || destinationPkScript[0] !== 0x51 || destinationPkScript[1] !== 0x20) {
    throw new Error("destination must be a P2TR pkScript (0x5120 + 32 bytes)");
  }
  return arkade.ArkadeScript.encode([
    "PUSHCURRENTINPUTINDEX",
    "DUP",
    "INSPECTOUTPUTSCRIPTPUBKEY",
    1,
    "EQUALVERIFY",
    destinationPkScript.subarray(2),
    "EQUALVERIFY",
    "INSPECTOUTPUTVALUE",
    "PUSHCURRENTINPUTINDEX",
    "INSPECTINPUTVALUE",
    "GREATERTHANOREQUAL",
  ] as Parameters<typeof arkade.ArkadeScript.encode>[0]);
};

export interface CovenantDestinationInput {
  /** The user's registered Arkade address — the only place the sweep may pay. */
  staticAddress: string;
  userPubkey: Uint8Array;
  serverPubkey: Uint8Array;
  emulatorPubkey: Uint8Array;
  /** 32 bytes, fresh per payment. Not a secret: the covenant makes it useless for theft. */
  preimage: Uint8Array;
  recoveryDelaySeconds: number;
}

export interface CovenantDestination {
  /** What the payer is given. Unique per payment. */
  address: string;
  /** hex pkScript — the attribution key a watcher looks up. */
  script: string;
  tapTree: Uint8Array;
  covenantScript: Uint8Array;
  sweepLeafIndex: number;
}

export function deriveCovenantDestination(input: CovenantDestinationInput): CovenantDestination {
  if (input.preimage.length !== 32) throw new Error(`preimage must be 32 bytes, got ${input.preimage.length}`);
  const staticPkScript = ArkAddress.decode(input.staticAddress).pkScript;
  const covenantScript = enforcePayTo(staticPkScript);
  const cosigner = arkade.computeArkadeScriptPublicKey(
    input.emulatorPubkey.length === 33 ? input.emulatorPubkey : Uint8Array.from([0x02, ...input.emulatorPubkey]),
    covenantScript,
  );
  const vtxo = new VtxoScript([
    ConditionMultisigTapscript.encode({
      conditionScript: preimageCondition(ripemd160(sha256(input.preimage))),
      pubkeys: [input.serverPubkey, cosigner],
    }).script,
    MultisigTapscript.encode({ pubkeys: [input.userPubkey, input.serverPubkey] }).script,
    CSVMultisigTapscript.encode({
      timelock: { type: "seconds", value: BigInt(input.recoveryDelaySeconds) },
      pubkeys: [input.userPubkey],
    }).script,
  ]);
  const hrp = input.staticAddress.slice(0, input.staticAddress.lastIndexOf("1"));
  return {
    address: vtxo.address(hrp, input.serverPubkey).encode(),
    script: hex.encode(vtxo.pkScript),
    tapTree: vtxo.encode(),
    covenantScript,
    sweepLeafIndex: 0,
  };
}
