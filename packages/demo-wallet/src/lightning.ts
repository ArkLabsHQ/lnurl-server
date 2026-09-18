import { getNetwork, resolveEmulatorPubkey, type PaymentRail } from "@arkade-os/sdk";
import {
  discoverMarkets,
  relayTransport,
  solverLightningRail,
  type SolverLightningSend,
} from "@arkade-os/swap";
import { defaultRegistryUrls } from "@arkade-os/solver-discovery";
import { hex } from "@scure/base";
import { invoiceFactsFromBolt11 } from "../../../src/bolt11.js";
import { ARK_SERVER, NETWORK } from "./config.js";

/** What `relayTransport` needs to address the solver: the wallet's x-only key. */
interface RailIdentity {
  xOnlyPublicKey(): Promise<Uint8Array> | Uint8Array;
}

const SWAP_KEY = "arkade-demo-wallet.lightning-swaps";

/**
 * The rail that pays a BOLT11 from Arkade funds, over the solver's
 * `BTC/lightning:BTC` corridor.
 *
 * Supplied to `lnurlRails` so `lnurl-lightning` can execute rather than being
 * registered and unable to pay. `decodeInvoice` is injected because the swap
 * package carries no bolt11 dependency; the server's own decoder is reused,
 * which is browser-safe — it only needs `@scure/base`.
 */
export function createLightningRail(identity: RailIdentity): PaymentRail {
  return solverLightningRail({
    arkServerUrl: ARK_SERVER,
    // Without this the rail is silently unavailable: no mutinynet market
    // advertises an emulator key of its own, so the rendezvous has nothing to
    // pin the covenant against and selects no market at all.
    emulatorPubkey: resolveEmulatorPubkey(getNetwork(NETWORK)),
    decodeInvoice: invoiceFactsFromBolt11,
    discover: () => discoverMarkets({ network: NETWORK, registryUrl: defaultRegistryUrls(NETWORK)[0] }),
    connect: async (rendezvous, fn) => {
      const relay = rendezvous.transports.nostr.relays[0];
      if (!relay) throw new Error("solver advertises no nostr relay");
      return fn(relayTransport(relay, {
        solverPubkey: rendezvous.solverPubkey,
        clientPubkey: hex.encode(await identity.xOnlyPublicKey()),
      }));
    },
    // A swap outlives the page: persisted so a reload can still find a lockup
    // that was funded but never claimed.
    persist: async (swap: SolverLightningSend) => {
      const all = JSON.parse(localStorage.getItem(SWAP_KEY) ?? "[]") as unknown[];
      all.push(JSON.parse(JSON.stringify(swap)));
      localStorage.setItem(SWAP_KEY, JSON.stringify(all));
    },
  });
}
