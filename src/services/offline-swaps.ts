// Server-orchestrated offline receive over the Arkade intents corridor
// (`lightning:BTC -> arkade:BTC`). When a wallet is offline, the server requests a
// quote from an intent solver, verifies the solver's hold invoice against the swap's
// own payment hash, and hands it to the payer as `pr`. The server generates the
// preimage P. The solver funds a VHTLC whose covenant can only pay the user's
// registered Arkade address (`enforcePayTo`), and this server pushes the covenant
// claim leaf itself once the payer pays — so it holds no user keys or funds. The
// RFQ carries no claim packet. Knowing P lets the server settle nothing itself:
// the covenant-constrained claim pays only the user, which is why a preimage may
// sit in the settlements table pre-settlement.
//
// The corridor client is the published `@arkade-os/swap` package;
// `ReverseSwapCreator` from the Boltz era is replaced by `OfflineSwapCreator`, same
// interface shape. The settlement poller reads solver status, so "settled" means the
// solver settled the payer's hold invoice, not merely that a lockup exists.

import { hex } from "@scure/base";
import { sideLimits } from "@arkade-os/solver-discovery";
import { ArkAddress, RestArkProvider, RestIndexerProvider, VHTLCV2ContractHandler, getNetwork, toXOnly, type NetworkName } from "@arkade-os/sdk";
import {
  deriveLightningReceive,
  lightningReceiveRequest,
  paymentHashOf,
  registerLockupContract,
  unilateralClaimDelay,
  verifyReceiveInvoice,
  type LockupContractWriter,
  type RfqTransport,
} from "@arkade-os/swap/protocol";
import { nostrRfqTransport } from "@arkade-os/swap/nostr";
import { verifyReceiveWindow } from "@arkade-os/swap/advanced";
import { invoiceFactsFromBolt11 } from "../bolt11.js";
import { MalformedRecordError, RailRefusedError, SolverQuoteError, UpstreamError } from "../errors.js";
import { checkedPreimage, randomEntropy, type EntropyProvider } from "../covenant/entropy.js";
import { createLogger, type Logger } from "../logger.js";
import type { DiscoveryService, SolverCandidate } from "./solver-discovery.js";
import { observeLockupPayout, type SelfClaimer, type SelfClaimOutcome } from "../covenant/self-claim.js";
import { deserializeSelfClaim } from "../covenant/self-claim-codec.js";

export interface OfflineSwapParams {
  /** Invoice amount by default; exact owner payout when amountSide is "to". */
  amountSat: number;
  amountSide?: "from" | "to";
  /** Required payer ceiling for net-targeted invoices, in sats. */
  maxPayAmountSat?: number;
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
  /** Unix seconds: the earlier of the invoice's expiry and the quote's valid_until.
   *  Optional so an injected creator that predates it still compiles. */
  invoiceExpiresAt?: number;
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

/** Wire states a receive never settles from. Not `stuck`: its operator may still settle it. */
export const CLOSED_RFQ_STATES: ReadonlySet<string> = new Set(["expired", "refused", "refunded"]);

export interface OfflineSwapCreator {
  /** Quote a solver-mediated receive paying `receiveAddress`. */
  create(params: OfflineSwapParams): Promise<OfflineSwapResult>;
  /** True once the solver reports the payer's invoice settled. */
  isSettled(swapId: string, recovery?: OfflineSwapRecoveryV1): Promise<boolean>;
  /** The solver's own state for the swap, undefined while unknown. Read in place of `isSettled` when present. */
  status?(swapId: string, recovery?: OfflineSwapRecoveryV1): Promise<string | undefined>;
  /** Present when the creator pushes the covenant claim leaf. @see SelfClaimer */
  selfClaim?(swapId: string, preimage: string, recovery?: OfflineSwapRecoveryV1): Promise<SelfClaimOutcome>;
  /** This lockup's payout to the covenant's receiver, or undefined while no spend proves one.
   *  Required, not a capability like {@link selfClaim}: settlement rests on nothing else, so a
   *  creator lacking it could settle no swap at all. @see observeLockupPayout */
  observePayout(swapId: string, recovery?: OfflineSwapRecoveryV1): Promise<string | undefined>;
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
  /** Emulator base URL — the source of the covenant's emulator key. */
  emulatorUrl: string;
  /** Arkade operator URL — signer key, exit delay and network come from its getInfo. */
  arkServerUrl: string;
  /** Pushes each lockup's covenant claim leaf. */
  selfClaimer?: SelfClaimer;
  /** Contract store each lockup is registered in, so src/workers/lockup-watcher.ts hears its
   *  funding as an event instead of the poller finding it a tick later. */
  contracts?: LockupContractWriter;
  transportFactory?: (candidate: Pick<SolverCandidate, "name" | "discoveryPubkey" | "relays">) => RfqTransport;
  /** Where the swap's HTLC secret comes from. Defaults to `randomBytes`. */
  entropy?: EntropyProvider;
  logger?: Logger;
}

/** Operator + claim facts a swap derivation needs. Refetched on a TTL so an
 *  operator/emulator rekey is picked up without a restart. */
interface CorridorContext {
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
    throw new SolverQuoteError(`solver quoted ${field} as ${JSON.stringify(value)}, which is not a whole number of sats`);
  }
  return value;
}

function compressedKey(v: unknown, name: string): Uint8Array {
  if (typeof v !== "string" || !/^0[23][0-9a-f]{64}$/i.test(v)) {
    throw new MalformedRecordError(`${name}: expected a 33-byte compressed pubkey (hex)`);
  }
  return hex.decode(v.toLowerCase());
}

/** Ceiling on each key fetch. Unbounded, a hung emulator parks every quote waiting on the
 *  corridor context, and those hold the MAX_CONCURRENT_OFFLINE_QUOTES slots with them. */
const KEY_FETCH_TIMEOUT_MS = 5_000;

/** Emulator key straight from the emulator: x-only or compressed hex, as served
 *  by `GET /v1/info`. */
async function fetchEmulatorKey(emulatorUrl: string): Promise<Uint8Array> {
  const res = await fetch(`${emulatorUrl}/v1/info`, { signal: AbortSignal.timeout(KEY_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new UpstreamError("emulator info endpoint", res.status);
  const body = (await res.json()) as { signerPubkey?: unknown };
  const v = body.signerPubkey;
  if (typeof v !== "string" || !/^([0-9a-f]{64}|0[23][0-9a-f]{64})$/i.test(v)) {
    throw new MalformedRecordError("emulator signerPubkey: expected 32-byte x-only or 33-byte compressed pubkey (hex)");
  }
  return hex.decode(v.toLowerCase());
}

/**
 * Real creator over the published RFQ corridor client (`@arkade-os/swap`).
 * Unit tests use fake transports; the funded E2E exercises a real solver,
 * emulator, and operator through a test-only HTTP RFQ adapter. Nostr transport
 * remains part of the deployment canary on the target network.
 */
export async function createOfflineSwapCoordinator(settings: IntentSwapSettings): Promise<OfflineSwapCreator> {
  const arkProvider = new RestArkProvider(settings.arkServerUrl);
  const indexer = new RestIndexerProvider(settings.arkServerUrl);
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
  const status = async (swapId: string, recovery?: OfflineSwapRecoveryV1): Promise<string | undefined> => {
    let transport = pinned.get(swapId);
    if (!transport && recovery) {
      if (recovery.rfqId !== swapId) throw new Error("offline swap recovery RFQ id mismatch");
      transport = transportFor({ name: recovery.solverName, discoveryPubkey: recovery.solverPubkey, relays: recovery.relays });
      pinned.set(swapId, transport);
    }
    if (!transport) throw new Error(`no pinned solver transport for swap ${swapId}`);
    return (await transport.status(swapId))?.state;
  };

  /** The lockup rebuilt from its persisted recovery row — no emulator or network, so operator
   *  key rotation cannot break it. Callers read the payout script off this, so the address
   *  check is what makes it trustworthy: a row rebuilding to another lockup is refused. */
  const restoreLockup = (swapId: string, recovery: OfflineSwapRecoveryV1): ReturnType<typeof deserializeSelfClaim> => {
    if (recovery.rfqId !== swapId) throw new Error("offline swap recovery RFQ id mismatch");
    const restored = deserializeSelfClaim(JSON.stringify({
      version: recovery.version,
      expectedAmount: recovery.expectedAmount,
      params: recovery.script,
    }));
    const hrp = ArkAddress.decode(recovery.lockupAddress).hrp;
    if (restored.script.address(hrp, restored.script.options.server).encode() !== recovery.lockupAddress) {
      throw new Error("offline swap recovery lockup address mismatch");
    }
    return restored;
  };

  let cached: { at: number; ctx: Promise<CorridorContext> } | null = null;
  const context = (): Promise<CorridorContext> => {
    const now = Date.now();
    if (!cached || now - cached.at > CONTEXT_TTL_MS) {
      const ctx = (async (): Promise<CorridorContext> => {
        const infoP = arkProvider.getInfo();
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
      const amountSide = params.amountSide ?? "from";
      const maxPayAmountSat = params.maxPayAmountSat;
      if (amountSide === "to" && (maxPayAmountSat === undefined || !Number.isSafeInteger(maxPayAmountSat) || maxPayAmountSat < params.amountSat)) {
        throw new Error("A maximum payer amount at least equal to the receive amount is required");
      }
      if (amountSide !== "to" && maxPayAmountSat !== undefined) {
        throw new Error("A maximum payer amount is only supported with amountSide 'to'");
      }
      const candidates = settings.discovery.selectLightningReceive(params.amountSat, ctx.emulatorPubkey, amountSide);
      if (!candidates.length) throw new RailRefusedError(`no solver card supports a ${params.amountSat} sat lightning receive`);
      const failures: string[] = [];

      for (const candidate of candidates) {
        const transport = transportFor(candidate);
        try {
          const preimage = checkedPreimage(settings.entropy ?? randomEntropy);
          const paymentHash = paymentHashOf(preimage);
          const rfqId = hex.encode(crypto.getRandomValues(new Uint8Array(32)));
          const quote = await transport.requestQuote(lightningReceiveRequest({
            rfqId,
            paymentHash,
            payoutAddress: params.receiveAddress,
            payoutPubkey,
            amount: params.amountSat,
            amountSide,
          }));
          const fromAmount = quoteSats("from_amount", quote.from_amount);
          const toAmount = quoteSats("to_amount", quote.to_amount);
          const targetAmount = amountSide === "to" ? toAmount : fromAmount;
          if (targetAmount !== params.amountSat) {
            throw new SolverQuoteError(`solver quoted ${amountSide}_amount ${targetAmount}, not the requested ${params.amountSat}`);
          }
          if (toAmount > fromAmount) throw new SolverQuoteError("solver quote pays out more than it takes in");
          if (maxPayAmountSat !== undefined && fromAmount > maxPayAmountSat) throw new SolverQuoteError("solver quote exceeds the maximum payer amount");
          const payer = sideLimits(candidate.market, "quote");
          if (amountSide === "to" && (!payer || BigInt(fromAmount) < payer.min || BigInt(fromAmount) > payer.max)) {
            throw new SolverQuoteError("solver quote exceeds its advertised payer bounds");
          }
          const derived = deriveLightningReceive({
            quote,
            paymentHash,
            payoutPubkey,
            payoutAddress: params.receiveAddress,
            operatorPubkey: ctx.serverPubkey,
            emulatorPubkey: ctx.emulatorPubkey,
            claimDelay: ctx.claimDelay,
            hrp: ctx.hrp,
          });
          const { payDeadline } = verifyReceiveInvoice({ invoice: derived.invoice, decode: invoiceFactsFromBolt11, paymentHash, quote });
          verifyReceiveWindow({ quote, quoteId: rfqId, payDeadline, now: Math.floor(Date.now() / 1000) });
          if (settings.contracts) {
            // Before the invoice leaves, so nothing funds a lockup with no row — but
            // not fatal as it is in a wallet: the poller claims off the indexer by
            // script, so a failed write costs speed, not the money.
            try {
              await registerLockupContract(settings.contracts, derived.script, derived.address);
            } catch (error) {
              logger.warn("offline_lockup_register_failed", { swapRef: rfqId.slice(0, 12), error });
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
            invoiceExpiresAt: payDeadline,
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
      throw new SolverQuoteError(`all solver candidates failed: ${failures.join("; ")}`);
    },

    status,

    async isSettled(swapId, recovery) {
      return (await status(swapId, recovery)) === "settled";
    },

    // Throws rather than answering "no payout" when the lockup cannot be rebuilt: conflating
    // the two would wedge a swap silently.
    observePayout: async (swapId, recovery) => {
      if (!recovery) throw new Error(`no recovery row to rebuild the lockup for swap ${swapId}`);
      return observeLockupPayout(restoreLockup(swapId, recovery).script, indexer);
    },

    ...(settings.selfClaimer
      ? { selfClaim: async (swapId: string, preimage: string, recovery?: OfflineSwapRecoveryV1) => {
          if (recovery) {
            const restored = restoreLockup(swapId, recovery);
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
