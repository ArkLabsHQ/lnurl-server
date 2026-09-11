// Server-orchestrated offline receive over the Arkade intents corridor
// (`lightning:BTC -> arkade:BTC`). When a wallet is offline, the server requests a
// quote from an intent solver, verifies the solver's hold invoice against the swap's
// own payment hash, and hands it to the payer as `pr`. The server generates the
// preimage P and seals it to covclaimd inside the RFQ request; the solver then funds
// a VHTLC whose covenant can only pay the user's registered Arkade address
// (`enforcePayTo`), and covclaimd claims it once the payer pays — so the server
// holds no user keys or funds. Knowing P lets the server settle nothing itself: the
// covenant-constrained claim pays only the user, which is why a preimage may sit in
// the settlements table pre-settlement.
//
// The corridor client is vendored at src/vendor/arkade-swap/ (see its README);
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
  unilateralClaimDelay,
  verifyReceiveInvoice,
  type RfqTransport,
} from "./vendor/arkade-swap/rfq.js";
import { sealClaimPacket } from "./vendor/arkade-swap/claimPacket.js";
import { nostrRfqTransport } from "./vendor/arkade-swap/nostr.js";
import { paymentHashOf } from "./vendor/arkade-swap/onchainHtlc.js";
import { invoiceFactsFromBolt11 } from "./bolt11.js";
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
  /** covclaimd base URL — its pubkey endpoint keys the sealed claim packet. */
  covclaimdUrl: string;
  /** Arkade operator URL — signer key, exit delay and network come from its getInfo. */
  arkServerUrl: string;
  /** Send the packet the solver stamps, not the ciphertext it reveals. @see OfflineReceiveConfig */
  stampClaimPacket?: boolean;
  /** Set under OFFLINE_SELF_CLAIM: pushes each lockup's covenant claim leaf. */
  selfClaimer?: SelfClaimer;
  transportFactory?: (candidate: Pick<SolverCandidate, "name" | "discoveryPubkey" | "relays">) => RfqTransport;
}

/** Operator + covclaimd facts a swap derivation needs. Refetched on a TTL so a
 *  covclaimd/operator rekey is picked up without a restart. */
interface CorridorContext {
  covclaimdPubkey: Uint8Array; // 33-byte compressed, for ECIES sealing
  emulatorPubkey: Uint8Array; // x-only — covclaimd's emulator co-signs the claim
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

/**
 * Real creator over a vendored RFQ corridor client (see src/vendor/arkade-swap/).
 * Unit tests use fake transports; the funded E2E exercises a real solver,
 * covclaimd, and operator through a test-only HTTP RFQ adapter. Nostr transport
 * remains part of the deployment canary on the target network.
 */
export async function createOfflineSwapCoordinator(settings: IntentSwapSettings): Promise<OfflineSwapCreator> {
  const arkProvider = new RestArkProvider(settings.arkServerUrl);
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
        const [keys, info] = await Promise.all([fetchCovclaimdKeys(settings.covclaimdUrl), arkProvider.getInfo()]);
        const network = getNetwork(info.network as NetworkName);
        return {
          covclaimdPubkey: keys.covclaimdPubkey,
          emulatorPubkey: toXOnly(keys.emulatorPubkey, "emulator signer key"),
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
      const candidates = settings.discovery.selectLightningReceive(params.amountSat);
      if (!candidates.length) throw new Error(`no solver card supports a ${params.amountSat} sat lightning receive`);
      const failures: string[] = [];

      for (const candidate of candidates) {
        const transport = transportFor(candidate);
        try {
          const preimage = randomBytes(32);
          const paymentHash = paymentHashOf(preimage);
          const rfqId = newRfqId();
          const sealed = await sealClaimPacket({ preimage, covclaimdPubkey: ctx.covclaimdPubkey });
          const claimPacket = settings.stampClaimPacket
            ? base64.encode(encodeClientClaimPacket({ ciphertext: base64.decode(sealed.ciphertext), covclaimdPubkey: ctx.covclaimdPubkey }))
            : sealed.ciphertext;
          const quote = await transport.requestQuote(lightningReceiveRequest({
            rfqId,
            paymentHash,
            payoutAddress: params.receiveAddress,
            payoutPubkey,
            claimPacket,
            amount: params.amountSat,
            amountSide: "from",
          }));
          if (quote.from_amount !== params.amountSat) {
            throw new Error(`solver quoted from_amount ${quote.from_amount}, not the requested ${params.amountSat}`);
          }
          if (quote.to_amount > quote.from_amount) throw new Error("solver quote pays out more than it takes in");
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
          settings.selfClaimer?.register({ swapId: rfqId, script: derived.script, expectedAmount: quote.to_amount });
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
              expectedAmount: quote.to_amount,
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
            const ctx = await context();
            const address = restored.script.address(ctx.hrp, ctx.serverPubkey).encode();
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
