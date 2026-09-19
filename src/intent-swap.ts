// Server-orchestrated offline receive over the Arkade intents corridor
// (`lightning:BTC -> arkade:BTC`). When a wallet is offline, the server requests a
// quote from an intent solver, verifies the solver's hold invoice against the swap's
// own payment hash, and hands it to the payer as `pr`. The server generates the
// preimage P. With COVCLAIMD_URL set it seals P to covclaimd inside the RFQ request;
// the solver then funds a VHTLC whose covenant can only pay the user's registered
// Arkade address (`enforcePayTo`), and covclaimd claims it once the payer pays — so
// the server holds no user keys or funds. With OFFLINE_SELF_CLAIM (no COVCLAIMD_URL)
// the RFQ omits the claim packet — optional on the wire, the solver funds anyway —
// and this server pushes the covenant leaf itself once the payer pays. Knowing P
// lets the server settle nothing itself: the covenant-constrained claim pays only
// the user, which is why a preimage may sit in the settlements table pre-settlement.
//
// The corridor client is the published `@arkade-os/swap` package;
// `ReverseSwapCreator` from the Boltz era is replaced by `OfflineSwapCreator`, same
// interface shape. The settlement poller reads solver status, so "settled" means the
// solver settled the payer's hold invoice, not merely that a lockup exists.

import { randomBytes } from "node:crypto";
import { base64, hex } from "@scure/base";
import { encodeClientClaimPacket } from "./claim-packet.js";
import { ArkAddress, RestArkProvider, VHTLCV2ContractHandler, getNetwork, toXOnly, type NetworkName } from "@arkade-os/sdk";
import {
  assertReceivable,
  deriveLightningReceive,
  lightningReceiveRequest,
  newRfqId,
  paymentHashOf,
  registerLockupContract,
  sealClaimPacket,
  unilateralClaimDelay,
  verifyReceiveInvoice,
  type LockupContractWriter,
  type RfqTransport,
} from "@arkade-os/swap";
import { nostrRfqTransport } from "@arkade-os/swap/nostr";
import { invoiceFactsFromBolt11 } from "./bolt11.js";
import { RailRefusedError } from "./rails.js";
import { createLogger, type Logger } from "./logger.js";
import type { DiscoveryService, SolverCandidate } from "./solver-discovery.js";
import type { SelfClaimer, SelfClaimOutcome } from "./self-claim.js";
import { deserializeSelfClaim } from "./self-claim-codec.js";

export interface OfflineSwapParams {
  /** Invoice amount in satoshis — the payer pays exactly this (`amountSide: "from"`). */
  amountSat: number;
  /** Receiver's Arkade address — the covenant claim is constrained to pay it. */
  receiveAddress: string;
  /** Receiver's compressed claim public key (hex); its x-only part is the covenant's receiver. */
  claimPublicKey: string;
  /** Client-derived preimage from the swap supply. Absent falls back to
   *  `randomBytes`, which the owner cannot re-derive. Note that a derivable
   *  preimage alone does not make a swap claimable: the VHTLC's script params
   *  come from the solver's quote, so the recovery blob is what closes that. */
  preimage?: Uint8Array;
}

export interface OfflineSwapResult {
  /** The RFQ id — the poller's status key. */
  swapId: string;
  /** bolt11 hold invoice handed to the payer. */
  invoice: string;
  /** Preimage generated during swap creation. The server holds it privately and
   *  only reveals it via LUD-21 `verify` once the swap settles. */
  preimage: string;
  /** Payment hash — the LUD-21 verify key. */
  preimageHash: string;
  lockupAddress: string;
  recovery: OfflineSwapRecoveryV1;
}

export interface OfflineSwapRecoveryV1 {
  version: 1;
  solverName: string;
  solverPubkey: string;
  relays: string[];
  rfqId: string;
  lockupAddress: string;
  expectedAmount: number;
  script: Record<string, string>;
}

export interface OfflineSwapCreator {
  /** Quote a solver-mediated receive paying `receiveAddress`. */
  create(params: OfflineSwapParams): Promise<OfflineSwapResult>;
  /** True once the solver reports the payer's invoice settled. */
  isSettled(swapId: string, recovery?: OfflineSwapRecoveryV1): Promise<boolean>;
  /** Present only under OFFLINE_SELF_CLAIM. @see SelfClaimer */
  selfClaim?(swapId: string, preimage: string, recovery?: OfflineSwapRecoveryV1): Promise<SelfClaimOutcome>;
  /** Close and forget one terminal swap's pinned transport. */
  release?(swapId: string): Promise<void>;
  /** Close transports whose swaps are no longer in durable pending storage. */
  prune?(activeSwapIds: readonly string[]): Promise<void>;
  /** Close every remaining transport during graceful shutdown. */
  close?(): Promise<void>;
}

export interface IntentSwapSettings {
  discovery: Pick<DiscoveryService, "selectLightningReceive">;
  /** 32-byte hex Nostr identity for the transport; ephemeral per boot when unset. */
  nostrSecretKey?: string;
  /** covclaimd base URL — its pubkey endpoint keys the sealed claim packet.
   *  Optional with OFFLINE_SELF_CLAIM: omitted, the RFQ carries no claim packet
   *  and the solver waits for this server's own claim. */
  covclaimdUrl?: string;
  /** Emulator base URL — the covenant's emulator key when no covclaimd is
   *  configured. Ignored when covclaimdUrl is set (its key stays authoritative). */
  emulatorUrl?: string;
  /** Arkade operator URL — signer key, exit delay and network come from its getInfo. */
  arkServerUrl: string;
  /** Send the packet the solver stamps, not the ciphertext it reveals. @see OfflineReceiveConfig */
  stampClaimPacket?: boolean;
  /** Set under OFFLINE_SELF_CLAIM: pushes each lockup's covenant claim leaf. */
  selfClaimer?: SelfClaimer;
  /** Contract store each lockup is registered in, so src/lockup-watcher.ts hears its
   *  funding as an event instead of the poller finding it a tick later. */
  contracts?: LockupContractWriter;
  transportFactory?: (candidate: Pick<SolverCandidate, "name" | "discoveryPubkey" | "relays">) => RfqTransport;
  logger?: Logger;
}

/** Operator + claim facts a swap derivation needs. Refetched on a TTL so an
 *  operator/emulator rekey is picked up without a restart. */
interface CorridorContext {
  /** 33-byte compressed, for ECIES sealing. Absent in self-claim mode: the RFQ
   *  omits the claim packet and no sealing happens. */
  covclaimdPubkey?: Uint8Array;
  emulatorPubkey: Uint8Array; // x-only — the covenant's emulator co-signer
  serverPubkey: Uint8Array; // x-only operator signer key
  claimDelay: number;
  hrp: string;
}

const CONTEXT_TTL_MS = 5 * 60_000;

function nostrTransport(solverPubkey: string, relays: string[], nostrSecretKey?: string): RfqTransport {
  if (!/^[0-9a-f]{64}$/i.test(solverPubkey)) {
    throw new Error("solver pubkey must be a 64-char hex (x-only) pubkey");
  }
  if (nostrSecretKey && !/^[0-9a-f]{64}$/i.test(nostrSecretKey)) {
    throw new Error("NOSTR_SECRET_KEY must be 64-char hex");
  }
  return nostrRfqTransport({
    relays,
    solverPubkey: solverPubkey.toLowerCase(),
    ...(nostrSecretKey ? { secretKey: hex.decode(nostrSecretKey.toLowerCase()) } : {}),
  });
}

/** A quote amount as sats.
 *
 *  `from_amount`/`to_amount` are a number of sats on HTLC-class corridors — which
 *  this one is — and a canonical decimal string only on arkade<->arkade asset
 *  legs, whose bigint range a JS number cannot hold. So a string here is a
 *  corridor the caller did not ask for, and rejecting beats coercing: `Number()`
 *  would silently round an asset amount, while leaving it alone is worse still,
 *  since `"50" !== 50` rejects a correct quote and `"9" > "10"` is true. */
function quoteSats(field: string, value: number | string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`solver quoted ${field} as ${JSON.stringify(value)}, which is not a whole number of sats`);
  }
  return value;
}

function compressedKey(v: unknown, name: string): Uint8Array {
  if (typeof v !== "string" || !/^0[23][0-9a-f]{64}$/i.test(v)) {
    throw new Error(`${name}: expected a 33-byte compressed pubkey (hex)`);
  }
  return hex.decode(v.toLowerCase());
}

async function fetchCovclaimdKeys(covclaimdUrl: string): Promise<{ covclaimdPubkey: Uint8Array; emulatorPubkey: Uint8Array }> {
  const res = await fetch(`${covclaimdUrl}/v1/preimage/covclaimd-pubkey`);
  if (!res.ok) throw new Error(`covclaimd pubkey endpoint: HTTP ${res.status}`);
  const body = (await res.json()) as { covclaimd_pub_key?: unknown; emulator_pub_key?: unknown };
  return {
    covclaimdPubkey: compressedKey(body.covclaimd_pub_key, "covclaimd_pub_key"),
    emulatorPubkey: compressedKey(body.emulator_pub_key, "emulator_pub_key"),
  };
}

/** Emulator key straight from the emulator: x-only or compressed hex, as served
 *  by `GET /v1/info`. Used only when no covclaimd is configured — otherwise the
 *  covclaimd-reported key stays authoritative so the covenant matches the solver. */
async function fetchEmulatorKey(emulatorUrl: string): Promise<Uint8Array> {
  const res = await fetch(`${emulatorUrl}/v1/info`);
  if (!res.ok) throw new Error(`emulator info endpoint: HTTP ${res.status}`);
  const body = (await res.json()) as { signerPubkey?: unknown };
  const v = body.signerPubkey;
  if (typeof v !== "string" || !/^([0-9a-f]{64}|0[23][0-9a-f]{64})$/i.test(v)) {
    throw new Error("emulator signerPubkey: expected 32-byte x-only or 33-byte compressed pubkey (hex)");
  }
  return hex.decode(v.toLowerCase());
}

/**
 * Real creator over the published RFQ corridor client (`@arkade-os/swap`).
 * Unit tests use fake transports; the funded E2E exercises a real solver,
 * covclaimd, and operator through a test-only HTTP RFQ adapter. Nostr transport
 * remains part of the deployment canary on the target network.
 */
export async function createOfflineSwapCoordinator(settings: IntentSwapSettings): Promise<OfflineSwapCreator> {
  const arkProvider = new RestArkProvider(settings.arkServerUrl);
  const logger = settings.logger ?? createLogger();
  const pinned = new Map<string, RfqTransport>();
  const transportFor: (candidate: Pick<SolverCandidate, "name" | "discoveryPubkey" | "relays">) => RfqTransport = settings.transportFactory ?? ((candidate) =>
    nostrTransport(candidate.discoveryPubkey, candidate.relays, settings.nostrSecretKey));
  const release = async (swapId: string): Promise<void> => {
    const transport = pinned.get(swapId);
    if (!transport) return;
    pinned.delete(swapId);
    await transport.close().catch(() => {});
  };

  let cached: { at: number; ctx: Promise<CorridorContext> } | null = null;
  const context = (): Promise<CorridorContext> => {
    const now = Date.now();
    if (!cached || now - cached.at > CONTEXT_TTL_MS) {
      const ctx = (async (): Promise<CorridorContext> => {
        const infoP = arkProvider.getInfo();
        if (settings.covclaimdUrl) {
          const [keys, info] = await Promise.all([fetchCovclaimdKeys(settings.covclaimdUrl), infoP]);
          const network = getNetwork(info.network as NetworkName);
          return {
            covclaimdPubkey: keys.covclaimdPubkey,
            emulatorPubkey: toXOnly(keys.emulatorPubkey, "emulator signer key"),
            serverPubkey: toXOnly(hex.decode(info.signerPubkey), "ark signer key"),
            claimDelay: unilateralClaimDelay(Number(info.unilateralExitDelay)),
            hrp: network.hrp,
          };
        }
        if (!settings.emulatorUrl) {
          throw new Error("offline receive requires COVCLAIMD_URL or (OFFLINE_SELF_CLAIM with OFFLINE_EMULATOR_URL)");
        }
        const [emulatorKey, info] = await Promise.all([fetchEmulatorKey(settings.emulatorUrl), infoP]);
        const network = getNetwork(info.network as NetworkName);
        return {
          emulatorPubkey: toXOnly(emulatorKey, "emulator signer key"),
          serverPubkey: toXOnly(hex.decode(info.signerPubkey), "ark signer key"),
          claimDelay: unilateralClaimDelay(Number(info.unilateralExitDelay)),
          hrp: network.hrp,
        };
      })();
      // A failed load is retried on the next create, not cached for the TTL.
      ctx.catch(() => { if (cached?.ctx === ctx) cached = null; });
      cached = { at: now, ctx };
    }
    return cached.ctx;
  };

  return {
    async create(params) {
      const payoutPubkey = toXOnly(compressedKey(params.claimPublicKey, "claimPublicKey"), "claimPublicKey");
      let payout: ArkAddress;
      try {
        payout = ArkAddress.decode(params.receiveAddress);
      } catch {
        throw new Error("receiveAddress is not a valid Arkade address");
      }
      const ctx = await context();
      if (payout.hrp !== ctx.hrp) {
        throw new Error(`receiveAddress prefix ${payout.hrp} does not match operator network (${ctx.hrp})`);
      }
      const candidates = settings.discovery.selectLightningReceive(params.amountSat, ctx.emulatorPubkey);
      if (!candidates.length) throw new RailRefusedError(`no solver card supports a ${params.amountSat} sat lightning receive`);
      const failures: string[] = [];

      for (const candidate of candidates) {
        const transport = transportFor(candidate);
        try {
          const preimage = params.preimage ?? randomBytes(32);
          if (preimage.length !== 32) throw new Error(`preimage must be 32 bytes, got ${preimage.length}`);
          const paymentHash = paymentHashOf(preimage);
          const rfqId = newRfqId();
          // Self-claim mode sends no packet: claim_packet is optional on the wire
          // and the solver funds anyway, waiting for our own covenant claim.
          let claimPacket: string | undefined;
          if (ctx.covclaimdPubkey) {
            const sealed = await sealClaimPacket({ preimage, covclaimdPubkey: ctx.covclaimdPubkey });
            claimPacket = settings.stampClaimPacket
              ? base64.encode(encodeClientClaimPacket({ ciphertext: base64.decode(sealed.ciphertext), covclaimdPubkey: ctx.covclaimdPubkey }))
              : sealed.ciphertext;
          } else if (settings.stampClaimPacket) {
            throw new Error("OFFLINE_STAMP_CLAIM_PACKET=true requires COVCLAIMD_URL (there is no packet to stamp without one)");
          }
          const quote = await transport.requestQuote(lightningReceiveRequest({
            rfqId,
            paymentHash,
            payoutAddress: params.receiveAddress,
            payoutPubkey,
            claimPacket,
            amount: params.amountSat,
            amountSide: "from",
          }));
          const fromAmount = quoteSats("from_amount", quote.from_amount);
          const toAmount = quoteSats("to_amount", quote.to_amount);
          if (fromAmount !== params.amountSat) {
            throw new Error(`solver quoted from_amount ${fromAmount}, not the requested ${params.amountSat}`);
          }
          if (toAmount > fromAmount) throw new Error("solver quote pays out more than it takes in");
          const derived = deriveLightningReceive({
            quote,
            paymentHash,
            payoutPubkey,
            payoutAddress: params.receiveAddress,
            serverPubkey: ctx.serverPubkey,
            emulatorPubkey: ctx.emulatorPubkey,
            claimDelay: ctx.claimDelay,
            hrp: ctx.hrp,
          });
          const { payDeadline } = verifyReceiveInvoice({ invoice: derived.invoice, decode: invoiceFactsFromBolt11, paymentHash, quote });
          assertReceivable({ quote, payDeadline, now: Math.floor(Date.now() / 1000) });
          if (settings.contracts) {
            // Before the invoice leaves, so nothing funds a lockup with no row — but
            // not fatal as it is in a wallet: the poller claims off the indexer by
            // script, so a failed write costs speed, not the money.
            try {
              await registerLockupContract(settings.contracts, derived.script, derived.address);
            } catch (error) {
              logger.warn("offline_lockup_register_failed", { swapId: rfqId, error });
            }
          }
          settings.selfClaimer?.register({ swapId: rfqId, script: derived.script, expectedAmount: toAmount });
          pinned.set(rfqId, transport);
          return {
            swapId: rfqId,
            invoice: derived.invoice,
            preimage: hex.encode(preimage),
            preimageHash: paymentHash,
            lockupAddress: derived.address,
            recovery: {
              version: 1,
              solverName: candidate.name,
              solverPubkey: candidate.discoveryPubkey,
              relays: [...candidate.relays],
              rfqId,
              lockupAddress: derived.address,
              expectedAmount: toAmount,
              script: VHTLCV2ContractHandler.serializeParams(derived.script.options),
            },
          };
        } catch (error) {
          await transport.close().catch(() => {});
          failures.push(`${candidate.name}: ${error instanceof Error ? error.message : "failed"}`);
        }
      }
      throw new Error(`all solver candidates failed: ${failures.join("; ")}`);
    },

    async isSettled(swapId, recovery) {
      let transport = pinned.get(swapId);
      if (!transport && recovery) {
        if (recovery.rfqId !== swapId) throw new Error("offline swap recovery RFQ id mismatch");
        transport = transportFor({ name: recovery.solverName, discoveryPubkey: recovery.solverPubkey, relays: recovery.relays });
        pinned.set(swapId, transport);
      }
      if (!transport) throw new Error(`no pinned solver transport for swap ${swapId}`);
      const status = await transport.status(swapId);
      return status?.state === "settled";
    },

    ...(settings.selfClaimer
      ? { selfClaim: async (swapId: string, preimage: string, recovery?: OfflineSwapRecoveryV1) => {
          if (recovery) {
            if (recovery.rfqId !== swapId) throw new Error("offline swap recovery RFQ id mismatch");
            const restored = deserializeSelfClaim(JSON.stringify({
              version: recovery.version,
              expectedAmount: recovery.expectedAmount,
              params: recovery.script,
            }));
            // Recovery must remain valid across operator key rotation. The server
            // key and network are persisted covenant data, not live dependencies.
            const hrp = ArkAddress.decode(recovery.lockupAddress).hrp;
            const address = restored.script.address(hrp, restored.script.options.server).encode();
            if (address !== recovery.lockupAddress) throw new Error("offline swap recovery lockup address mismatch");
            settings.selfClaimer!.register({ swapId, script: restored.script, expectedAmount: restored.expectedAmount });
          }
          return settings.selfClaimer!.claim(swapId, preimage);
        } }
      : {}),

    release,
    prune: async (activeSwapIds) => {
      const active = new Set(activeSwapIds);
      await Promise.allSettled([...pinned.keys()]
        .filter((swapId) => !active.has(swapId))
        .map((swapId) => release(swapId)));
    },

    close: async () => {
      await Promise.allSettled([...new Set(pinned.values())].map((transport) => transport.close()));
      pinned.clear();
    },
  };
}
