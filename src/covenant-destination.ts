// Per-payment destinations for the Arkade rail: the script is the identifier, so
// concurrent payments need no guessing from amount and arrival time.
//
//   leaf 0  condition(H(P)) + operator + covenant cosigner  sweep, pinned
//   leaf 1  user + operator                                 collaborative
//   leaf 2  user alone after CSV                            unilateral recovery
//
// Only leaf 0 carries H(P): a fresh preimage moves the address, the covenant bytes
// stay fixed, and the user's two recovery paths need neither P nor this server.

import { randomBytes } from "node:crypto";
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

/**
 * "This input's output pays `destination`, value >= the input." Re-emitted rather
 * than imported: the emulator co-signs only a covenant hashing to the key in the
 * leaf, so these bytes must match `solver-arkade/arkade/covenant.ts` exactly.
 *
 * `INSPECTOUTPUTSCRIPTPUBKEY` pushes program THEN witness version, so version is on
 * top — hence `1 EQUALVERIFY` (Taproot) before the 32-byte program, which reads
 * backwards in source order. Swapping them compares a version against a key and the
 * emulator refuses every sweep.
 */
export const enforcePayTo = (destinationPkScript: Uint8Array): Uint8Array => {
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

/** What the callback needs per payment. Hex throughout, so it stores as-is. */
export interface DerivedDestination {
  address: string;
  script: string;
  preimage: string;
  tapTree: string;
  /** Where the covenant forces the sweep to pay — the user's static address. */
  payoutScript: string;
}

export interface CovenantDestinationProvider {
  derive(address: { arkadeAddress: string; claimPublicKey: string }): Promise<DerivedDestination>;
}

const CONTEXT_TTL_MS = 5 * 60_000;

/**
 * Reads the operator and emulator keys the covenant commits to, refetched on a TTL
 * so a rekey is picked up without a restart. The emulator key comes from covclaimd
 * for the same reason the offline path takes it from there: it must be the one
 * whose covenants the network already accepts.
 */
export function createCovenantDestinationProvider(opts: {
  arkServerUrl: string;
  covclaimdUrl: string;
  recoveryDelaySeconds: number;
  now?: () => number;
}): CovenantDestinationProvider {
  // Here rather than only at derivation: BIP68's throw arrives per payment, where
  // the caller falls back to the static address, so the flag looks on and does
  // nothing. Construction is the last point that can still fail loudly.
  if (!Number.isInteger(opts.recoveryDelaySeconds) || opts.recoveryDelaySeconds <= 0 || opts.recoveryDelaySeconds % 512 !== 0) {
    throw new Error(`recoveryDelaySeconds must be a positive multiple of 512 (got ${opts.recoveryDelaySeconds})`);
  }
  const now = opts.now ?? (() => Date.now());
  let cached: { at: number; serverPubkey: Uint8Array; emulatorPubkey: Uint8Array } | undefined;

  // A 4xx body parses into an envelope with the field missing, so the decode error
  // hides the status that caused it.
  const getJson = async <T>(url: string): Promise<T> => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return (await res.json()) as T;
  };

  const context = async () => {
    if (cached && now() - cached.at < CONTEXT_TTL_MS) return cached;
    const [info, keys] = await Promise.all([
      getJson<{ signerPubkey: string }>(`${opts.arkServerUrl}/v1/info`),
      getJson<{ emulator_pub_key: string }>(`${opts.covclaimdUrl}/v1/preimage/covclaimd-pubkey`),
    ]);
    cached = {
      at: now(),
      serverPubkey: toXOnly(hex.decode(info.signerPubkey)),
      emulatorPubkey: hex.decode(keys.emulator_pub_key),
    };
    return cached;
  };

  return {
    async derive(address) {
      const { serverPubkey, emulatorPubkey } = await context();
      const preimage = randomBytes(32);
      const d = deriveCovenantDestination({
        staticAddress: address.arkadeAddress,
        userPubkey: toXOnly(hex.decode(address.claimPublicKey)),
        serverPubkey,
        emulatorPubkey,
        preimage,
        recoveryDelaySeconds: opts.recoveryDelaySeconds,
      });
      return {
        address: d.address,
        script: d.script,
        preimage: hex.encode(preimage),
        tapTree: hex.encode(d.tapTree),
        payoutScript: hex.encode(ArkAddress.decode(address.arkadeAddress).pkScript),
      };
    },
  };
}

/** Stripping unconditionally turns an x-only key into 31 bytes, and the covenant
 *  commits to it without complaint — only the refused sweep would ever say so. */
const toXOnly = (key: Uint8Array): Uint8Array => {
  if (key.length === 32) return key;
  if (key.length === 33) return key.subarray(1);
  throw new Error(`expected a 32- or 33-byte key, got ${key.length} bytes`);
};

/** The cosigner derivation takes a compressed key; a wrong length would tweak into
 *  a cosigner nothing can sign for, and only the refused sweep would say so. */
const toCompressed = (key: Uint8Array): Uint8Array => {
  if (key.length === 33) return key;
  if (key.length === 32) return Uint8Array.from([0x02, ...key]);
  throw new Error(`expected a 32- or 33-byte key, got ${key.length} bytes`);
};

export function deriveCovenantDestination(input: CovenantDestinationInput): CovenantDestination {
  if (input.preimage.length !== 32) throw new Error(`preimage must be 32 bytes, got ${input.preimage.length}`);
  const userPubkey = toXOnly(input.userPubkey);
  const serverPubkey = toXOnly(input.serverPubkey);
  const staticPkScript = ArkAddress.decode(input.staticAddress).pkScript;
  const covenantScript = enforcePayTo(staticPkScript);
  const cosigner = arkade.computeArkadeScriptPublicKey(toCompressed(input.emulatorPubkey), covenantScript);
  const vtxo = new VtxoScript([
    ConditionMultisigTapscript.encode({
      conditionScript: preimageCondition(ripemd160(sha256(input.preimage))),
      pubkeys: [serverPubkey, cosigner],
    }).script,
    MultisigTapscript.encode({ pubkeys: [userPubkey, serverPubkey] }).script,
    CSVMultisigTapscript.encode({
      timelock: { type: "seconds", value: BigInt(input.recoveryDelaySeconds) },
      pubkeys: [userPubkey],
    }).script,
  ]);
  const hrp = input.staticAddress.slice(0, input.staticAddress.lastIndexOf("1"));
  return {
    address: vtxo.address(hrp, serverPubkey).encode(),
    script: hex.encode(vtxo.pkScript),
    tapTree: vtxo.encode(),
    covenantScript,
    sweepLeafIndex: 0,
  };
}
