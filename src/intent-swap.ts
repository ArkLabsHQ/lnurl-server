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
import { hex } from "@scure/base";
import { ArkAddress, RestArkProvider, getNetwork, toXOnly, type NetworkName } from "@arkade-os/sdk";
import {
  assertReceivable,
  deriveLightningReceive,
  httpTransport,
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
}

export interface OfflineSwapCreator {
  /** Quote a solver-mediated receive paying `receiveAddress`. */
  create(params: OfflineSwapParams): Promise<OfflineSwapResult>;
  /** True once the solver reports the payer's invoice settled. */
  isSettled(swapId: string): Promise<boolean>;
}

export interface IntentSwapSettings {
  /** Intent solver's RFQ HTTP base URL (`POST /v1/swap`, `GET /v1/rfq/:id`) — dev/custom solvers. */
  solverUrl?: string;
  /** Solver's x-only discovery pubkey (hex) — Nostr RFQ, the production transport. */
  solverPubkey?: string;
  /** Nostr relays (wss://…) the solver listens on. */
  nostrRelays?: string[];
  /** 32-byte hex Nostr identity for the transport; ephemeral per boot when unset. */
  nostrSecretKey?: string;
  /** covclaimd base URL — its pubkey endpoint keys the sealed claim packet. */
  covclaimdUrl: string;
  /** Arkade operator URL — signer key, exit delay and network come from its getInfo. */
  arkServerUrl: string;
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

/** HTTP when a solver URL is configured (dev/custom), Nostr directed-RFQ otherwise —
 *  the production transport deployed solvers actually listen on. */
function buildTransport(settings: IntentSwapSettings): RfqTransport {
  if (settings.solverUrl) return httpTransport(settings.solverUrl);
  if (!settings.solverPubkey || !settings.nostrRelays?.length) {
    throw new Error("offline receive needs a solver transport: SOLVER_URL, or SOLVER_PUBKEY + NOSTR_RELAYS");
  }
  if (!/^[0-9a-f]{64}$/i.test(settings.solverPubkey)) {
    throw new Error("SOLVER_PUBKEY must be a 64-char hex (x-only) pubkey");
  }
  if (settings.nostrSecretKey && !/^[0-9a-f]{64}$/i.test(settings.nostrSecretKey)) {
    throw new Error("NOSTR_SECRET_KEY must be 64-char hex");
  }
  return nostrRfqTransport({
    relays: settings.nostrRelays,
    solverPubkey: settings.solverPubkey.toLowerCase(),
    ...(settings.nostrSecretKey ? { secretKey: hex.decode(settings.nostrSecretKey.toLowerCase()) } : {}),
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
 * The live path (a real solver + covclaimd + operator) is not exercised in CI — the
 * integration test drives this against fake HTTP servers implementing the same wire
 * contracts. Mutinynet/mainnet verification is the deployment's to do once.
 */
export function createIntentSwapCreator(settings: IntentSwapSettings): OfflineSwapCreator {
  const transport: RfqTransport = buildTransport(settings);
  const arkProvider = new RestArkProvider(settings.arkServerUrl);

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

      const preimage = randomBytes(32);
      const paymentHash = paymentHashOf(preimage);
      const rfqId = newRfqId();
      const ctx = await context();
      if (payout.hrp !== ctx.hrp) {
        throw new Error(`receiveAddress prefix ${payout.hrp} does not match operator network (${ctx.hrp})`);
      }
      const claimPacket = await sealClaimPacket({ preimage, covclaimdPubkey: ctx.covclaimdPubkey });

      const quote = await transport.requestQuote(
        lightningReceiveRequest({
          rfqId,
          paymentHash,
          payoutAddress: params.receiveAddress,
          payoutPubkey,
          claimPacket: claimPacket.ciphertext,
          amount: params.amountSat,
          amountSide: "from",
        }),
      );
      // Upstream's assertQuotedAmount is module-private; these are its two checks
      // for amountSide "from" — the invoice must ask exactly what the payer chose.
      // TRACKING DEBT: when the vendor exit plan lands (@arkade-os/swap release),
      // switch to the package's public receive API rather than hand-replicating
      // the guard — a third upstream check would silently pass us by until then.
      if (quote.from_amount !== params.amountSat) {
        throw new Error(`solver quoted from_amount ${quote.from_amount}, not the requested ${params.amountSat}`);
      }
      if (quote.to_amount > quote.from_amount) {
        throw new Error("solver quote pays out more than it takes in");
      }

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
      const { payDeadline } = verifyReceiveInvoice({
        invoice: derived.invoice,
        decode: invoiceFactsFromBolt11,
        paymentHash,
        quote,
      });
      assertReceivable({ quote, payDeadline, now: Math.floor(Date.now() / 1000) });

      return {
        swapId: rfqId,
        invoice: derived.invoice,
        preimage: hex.encode(preimage),
        preimageHash: paymentHash,
        lockupAddress: derived.address,
      };
    },

    async isSettled(swapId) {
      const status = await transport.status(swapId);
      return status?.state === "settled";
    },
  };
}
