// Per-payment destinations for the Arkade rail: the script is the identifier, so
// concurrent payments need no guessing from amount and arrival time.
//
// The script is the SDK's own VHTLC with BOTH roles held by the user. That is what
// makes the whole leaf ladder safe without auditing it leaf by leaf: every path
// either requires the user's signature or is `enforcePayTo`-pinned to the user's
// registered address, so none of them can send the payment anywhere else. The one
// we spend is `nonInteractiveClaim` — preimage + operator + covenant-tweaked
// emulator — which is the same leaf the offline-swap rail claims.
//
// Only that leaf carries H(P): a fresh preimage moves the address, the covenant
// bytes stay fixed, and the user's recovery paths need neither P nor this server.

import type { IContractManager } from "@arkade-os/sdk";
import { COVENANT_CONTRACT_TYPE, covenantDestinationHandler } from "./covenant-contract.js";
import { checkedPreimage, randomEntropy, type EntropyProvider } from "./entropy.js";
import { hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { ArkAddress, VHTLC } from "@arkade-os/sdk";

export interface CovenantDestinationInput {
  /** The user's registered Arkade address — the only place the sweep may pay. */
  staticAddress: string;
  userPubkey: Uint8Array;
  serverPubkey: Uint8Array;
  emulatorPubkey: Uint8Array;
  /** 32 bytes, fresh per payment. Not a secret: the covenant makes it useless for theft. */
  preimage: Uint8Array;
  recoveryDelaySeconds: number;
  /** Absolute unix seconds. Gates the covenant's second recovery tier, which pays
   *  the user's own address, so it is a floor on when that opens and not a
   *  deadline anyone can miss. */
  refundLocktime: number;
}

export interface CovenantDestination {
  /** What the payer is given. Unique per payment. */
  address: string;
  /** hex pkScript — the attribution key a watcher looks up. */
  script: string;
  tapTree: Uint8Array;
  covenantScript: Uint8Array;
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
        // The covenant's second recovery tier opens here. Measured from now so it
        // tracks the payment rather than a fixed epoch, and stored in the contract
        // params, so re-deriving the script later reproduces this exact address.
        refundLocktime: Math.floor(now() / 1000) + opts.recoveryDelaySeconds,
      };
      const { vtxo } = covenantVtxoScript(params);
      const d = deriveCovenantDestination(params);
      // Before the address is returned, never after: a payer handed a destination
      // nothing is watching has no way to be credited. A throw here reaches the
      // caller's fallback to the static address, which is the same failure mode as
      // derivation itself failing. `awaiting-funds` is the SDK's one-shot lifecycle —
      // watched until a vtxo lands, then demoted off every background channel.
      await opts.contracts?.createContract({
        type: COVENANT_CONTRACT_TYPE,
        // The VHTLC's own parameters commit to the preimage HASH, so P rides
        // alongside them under a key the SDK's deserializer ignores. Deliberately
        // NOT `preimage`: the SDK's selectPath reads that key to offer the
        // collaborative `claim()` leaf, a different leaf with different signers,
        // and only the sender-before-receiver order in its resolveRole keeps the
        // two apart today. Keeping P in the clear costs nothing — the covenant,
        // not the secret, is what pins where a sweep may pay.
        params: { ...covenantDestinationHandler.serializeParams(vtxo.options), covenantPreimage: hex.encode(preimage) },
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
export function covenantVtxoScript(
  input: CovenantDestinationInput,
): { vtxo: InstanceType<typeof VHTLC.ScriptV2>; covenantScript: Uint8Array } {
  if (input.preimage.length !== 32) throw new Error(`preimage must be 32 bytes, got ${input.preimage.length}`);
  const user = toXOnly(input.userPubkey);
  const payTo = ArkAddress.decode(input.staticAddress).pkScript;
  const delay = { type: "seconds", value: BigInt(input.recoveryDelaySeconds) } as const;
  const vtxo = new VHTLC.ScriptV2({
    // Both roles are the user. That is what makes every leaf safe without us
    // auditing any of them: each one either needs the user's own signature or is
    // `enforcePayTo`-pinned to the user's address, so none can redirect funds.
    sender: user,
    receiver: user,
    server: toXOnly(input.serverPubkey),
    preimageHash: ripemd160(sha256(input.preimage)),
    // Wall-clock typed: arkd refuses a height-typed locktime on a forfeit-eligible
    // leaf. It gates only `nonInteractiveRefundWithoutReceiver`, which pays the
    // user too, so it is a second recovery tier rather than a deadline.
    refundLocktime: BigInt(input.refundLocktime),
    // One value for all three tiers. The ladder exists to keep a claim ahead of a
    // counterparty's refund; with no counterparty there is no race to order.
    unilateralClaimDelay: delay,
    unilateralRefundDelay: delay,
    unilateralRefundWithoutReceiverDelay: delay,
    nonInteractiveParameters: {
      emulatorPubkey: toCompressed(input.emulatorPubkey),
      receiverPkScript: payTo,
      senderPkScript: payTo,
    },
  });
  const [, covenantScript] = vtxo.nonInteractiveClaim();
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
  };
}
