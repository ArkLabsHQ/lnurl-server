// Per-payment destinations for the Arkade rail: the script is the identifier, so
// concurrent payments need no guessing from amount and arrival time.
//
//   leaf 0  condition(H(P)) + operator + covenant cosigner  sweep, pinned
//   leaf 1  user + operator                                 collaborative
//   leaf 2  user alone after CSV                            unilateral recovery
//
// Only leaf 0 carries H(P): a fresh preimage moves the address, the covenant bytes
// stay fixed, and the user's two recovery paths need neither P nor this server.

import type { IContractManager } from "@arkade-os/sdk";
import { COVENANT_CONTRACT_TYPE, covenantDestinationHandler } from "./covenant-contract.js";
import { checkedPreimage, randomEntropy, type EntropyProvider } from "./entropy.js";
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
/** 0xf7. Spliced as a byte: the SDK's opcode table stops at SIGHASH (0xf6). */
const OP_TUNNEL = 0xf7;
/** Flag 4 preserves input-local asset IDs and amounts. */
const TUNNEL_ASSETS = 4;

/** A row stored without a version is v1 and must stay v1: its money sits at an
 *  address only those bytes reproduce. */
export const COVENANT_V1 = 1;
export const COVENANT_V2 = 2;
/** REQUIRES an emulator implementing OP_TUNNEL (>= v0.0.8-rc.0). v0.0.7 maps 0xf7
 *  to opcodeInvalid and refuses the sweep, stranding EVERY covenant destination. */
export const COVENANT_CURRENT = COVENANT_V2;

export const enforcePayTo = (destinationPkScript: Uint8Array): Uint8Array => {
  if (destinationPkScript.length !== 34 || destinationPkScript[0] !== 0x51 || destinationPkScript[1] !== 0x20) {
    throw new Error("destination must be a P2TR pkScript (0x5120 + 32 bytes)");
  }
  return arkade.ArkadeScript.encode([
    "PUSHCURRENTINPUTINDEX",
    "DUP",
    // Pushes (program, version) with VERSION ON TOP, so the two EQUALVERIFYs below
    // read backwards from source order: version first, then program. See the docblock.
    "INSPECTOUTPUTSCRIPTPUBKEY",
    1, // witness version — Taproot
    "EQUALVERIFY",
    destinationPkScript.subarray(2), // the 32-byte program
    "EQUALVERIFY",
    "INSPECTOUTPUTVALUE",
    "PUSHCURRENTINPUTINDEX",
    "INSPECTINPUTVALUE",
    "GREATERTHANOREQUAL",
  ] as Parameters<typeof arkade.ArkadeScript.encode>[0]);
};

/**
 * v1 plus asset preservation: what arrives must leave on the output already pinned
 * to the user, so the covenant secures assets rather than trusting this service.
 *
 * The tunnel goes FIRST, on an empty stack: opcodeTunnel pops the exception count
 * and needs exactly [outputIndex, flags] beneath it. It pushes true, hence VERIFY.
 */
export const enforcePayToWithAssets = (destinationPkScript: Uint8Array): Uint8Array => {
  const tunnel = arkade.ArkadeScript.encode([
    "PUSHCURRENTINPUTINDEX", // the output this input must tunnel into
    TUNNEL_ASSETS,
    0, // no asset exceptions: everything that arrives must leave
  ] as Parameters<typeof arkade.ArkadeScript.encode>[0]);
  const verify = arkade.ArkadeScript.encode(["VERIFY"] as Parameters<typeof arkade.ArkadeScript.encode>[0]);
  const payTo = enforcePayTo(destinationPkScript);
  const out = new Uint8Array(tunnel.length + 1 + verify.length + payTo.length);
  out.set(tunnel, 0);
  out[tunnel.length] = OP_TUNNEL;
  out.set(verify, tunnel.length + 1);
  out.set(payTo, tunnel.length + 1 + verify.length);
  return out;
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
  /** Absent is v1 — the construction that predates asset preservation. */
  version?: number;
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

/** What the callback needs per payment: the address to hand the payer and the script
 *  that attributes their payment. Everything else about the covenant lives on the
 *  contract registered at derivation. */
export interface DerivedDestination {
  address: string;
  script: string;
}

export interface CovenantDestinationProvider {
  derive(address: { arkadeAddress: string; claimPublicKey: string }): Promise<DerivedDestination>;
}

const CONTEXT_TTL_MS = 5 * 60_000;
/** Matches the pairing probe in src/self-claim.ts: long enough for a healthy
 *  round trip, short enough that a dead dependency fails rather than parks. */
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Reads the operator and emulator keys the covenant commits to, refetched on a TTL
 * so a rekey is picked up without a restart. With COVCLAIMD_URL set the emulator
 * key comes from covclaimd — it must be the one whose covenants the network
 * already accepts. Without it (self-claim / arkade-rail-only mode) the key comes
 * straight from OFFLINE_EMULATOR_URL, which is then the emulator that must sweep.
 */
export function createCovenantDestinationProvider(opts: {
  arkServerUrl: string;
  covclaimdUrl?: string;
  emulatorUrl?: string;
  recoveryDelaySeconds: number;
  /** Absent keeps the provider standalone (unit tests, the probe script); present
   *  makes every derived destination a contract the SDK watches and can spend. */
  contracts?: IContractManager;
  /** Where the sweep leaf's secret comes from. Defaults to `randomBytes`. */
  entropy?: EntropyProvider;
  /** Ceiling on each key fetch. Unbounded, a hung arkd or emulator holds every
   *  concurrent derivation with it, and those share the offline-quote slots. */
  requestTimeoutMs?: number;
  now?: () => number;
}): CovenantDestinationProvider {
  // Here rather than only at derivation: BIP68's throw arrives per payment, where
  // the caller falls back to the static address, so the flag looks on and does
  // nothing. Construction is the last point that can still fail loudly.
  if (!Number.isInteger(opts.recoveryDelaySeconds) || opts.recoveryDelaySeconds <= 0 || opts.recoveryDelaySeconds % 512 !== 0) {
    throw new Error(`recoveryDelaySeconds must be a positive multiple of 512 (got ${opts.recoveryDelaySeconds})`);
  }
  const now = opts.now ?? (() => Date.now());
  let cached: { at: number; ctx: Promise<{ serverPubkey: Uint8Array; emulatorPubkey: Uint8Array }> } | undefined;
  if (!opts.covclaimdUrl && !opts.emulatorUrl) {
    throw new Error("covenant destinations require covclaimdUrl or emulatorUrl (the covenant commits to the emulator key)");
  }

  // A 4xx body parses into an envelope with the field missing, so the decode error
  // hides the status that caused it.
  const getJson = async <T>(url: string): Promise<T> => {
    const res = await fetch(url, { signal: AbortSignal.timeout(opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return (await res.json()) as T;
  };

  // The promise is cached, not the value it settles to: derivations arrive
  // concurrently, and caching only the result let every one of them past an
  // expired TTL start its own pair of fetches.
  const context = (): Promise<{ serverPubkey: Uint8Array; emulatorPubkey: Uint8Array }> => {
    if (cached && now() - cached.at < CONTEXT_TTL_MS) return cached.ctx;
    const ctx = (async () => {
      const infoP = getJson<{ signerPubkey: string }>(`${opts.arkServerUrl}/v1/info`);
      const emulatorP = opts.covclaimdUrl
        ? getJson<{ emulator_pub_key: string }>(`${opts.covclaimdUrl}/v1/preimage/covclaimd-pubkey`).then((keys) => keys.emulator_pub_key)
        : getJson<{ signerPubkey: string }>(`${opts.emulatorUrl}/v1/info`).then((info) => info.signerPubkey);
      const [info, emulatorKey] = await Promise.all([infoP, emulatorP]);
      return {
        serverPubkey: toXOnly(hex.decode(info.signerPubkey)),
        emulatorPubkey: hex.decode(String(emulatorKey)),
      };
    })();
    // A failed load is retried on the next derivation, not pinned for the TTL.
    ctx.catch(() => { if (cached?.ctx === ctx) cached = undefined; });
    cached = { at: now(), ctx };
    return ctx;
  };

  return {
    async derive(address) {
      const { serverPubkey, emulatorPubkey } = await context();
      const preimage = checkedPreimage(opts.entropy ?? randomEntropy);
      const params = {
        staticAddress: address.arkadeAddress,
        userPubkey: toXOnly(hex.decode(address.claimPublicKey)),
        serverPubkey,
        emulatorPubkey,
        preimage,
        recoveryDelaySeconds: opts.recoveryDelaySeconds,
        // Stamped, so a row can always be rebuilt as whatever it was derived as.
        version: COVENANT_CURRENT,
      };
      const d = deriveCovenantDestination(params);
      // Before the address is returned, never after: a payer handed a destination
      // nothing is watching has no way to be credited. A throw here reaches the
      // caller's fallback to the static address, which is the same failure mode as
      // derivation itself failing. `awaiting-funds` is the SDK's one-shot lifecycle —
      // watched until a vtxo lands, then demoted off every background channel.
      await opts.contracts?.createContract({
        type: COVENANT_CONTRACT_TYPE,
        params: covenantDestinationHandler.serializeParams(params),
        script: d.script,
        address: d.address,
        watch: "awaiting-funds",
      });
      return { address: d.address, script: d.script };
    },
  };
}

/** Stripping unconditionally turns an x-only key into 31 bytes, and the covenant
 *  commits to it without complaint — only the refused sweep would ever say so.
 *  Exported so callers that need the key *before* derivation share this guard
 *  rather than writing `.subarray(1)` and reintroducing the same defect. */
export const toXOnly = (key: Uint8Array): Uint8Array => {
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

/** Indices into the array {@link covenantVtxoScript} hands `VtxoScript`, so they move
 *  with it. {@link SWEEP_LEAF} is the leaf the emulator co-signs; the sweeper finds it
 *  by script identity rather than by position, since no order is promised. */
export const SWEEP_LEAF = 0;
export const COLLABORATIVE_LEAF = 1;
export const RECOVERY_LEAF = 2;

/** The construction itself, shared by {@link deriveCovenantDestination} and the
 *  contract handler's `createScript` so neither can drift from the other. */
export function covenantVtxoScript(input: CovenantDestinationInput): { vtxo: VtxoScript; covenantScript: Uint8Array } {
  if (input.preimage.length !== 32) throw new Error(`preimage must be 32 bytes, got ${input.preimage.length}`);
  const userPubkey = toXOnly(input.userPubkey);
  const serverPubkey = toXOnly(input.serverPubkey);
  // Branch, never edit: a v1 row's money is at an address only the v1 bytes
  // reproduce, and rebuilding it as v2 addresses a taptree nobody funded.
  const destination = ArkAddress.decode(input.staticAddress).pkScript;
  const covenantScript = (input.version ?? COVENANT_V1) >= COVENANT_V2
    ? enforcePayToWithAssets(destination)
    : enforcePayTo(destination);
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
  return { vtxo, covenantScript };
}

export function deriveCovenantDestination(input: CovenantDestinationInput): CovenantDestination {
  const { vtxo, covenantScript } = covenantVtxoScript(input);
  const hrp = input.staticAddress.slice(0, input.staticAddress.lastIndexOf("1"));
  return {
    address: vtxo.address(hrp, toXOnly(input.serverPubkey)).encode(),
    script: hex.encode(vtxo.pkScript),
    tapTree: vtxo.encode(),
    covenantScript,
    sweepLeafIndex: SWEEP_LEAF,
  };
}
