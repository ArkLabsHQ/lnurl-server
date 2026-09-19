import { getNetwork, resolveEmulatorPubkey, toXOnly, type PaymentRail } from "@arkade-os/sdk";
import {
  discoverMarkets,
  relayTransport,
  solverLightningRail,
  type SolverLightningSend,
} from "@arkade-os/swap";
import { defaultRegistryUrls } from "@arkade-os/solver-discovery";
import { hex } from "@scure/base";
import { invoiceFactsFromBolt11 } from "../../../src/bolt11.js";
import { ARK_SERVER, EMULATOR_PUBKEY, NETWORK, SOLVER_REGISTRY_URL } from "./config.js";

/** What `relayTransport` needs to address the solver: the wallet's x-only key. */
interface RailIdentity {
  xOnlyPublicKey(): Promise<Uint8Array> | Uint8Array;
}

const SWAP_KEY = "arkade-demo-wallet.lightning-swaps";

/** A network the SDK pins no emulator for throws here, and at module scope that
 *  would take the whole bundle down rather than drop one rail. */
const EMULATOR_HEX = ((): string | undefined => {
  if (EMULATOR_PUBKEY) return EMULATOR_PUBKEY;
  try { return resolveEmulatorPubkey(getNetwork(NETWORK)); } catch { return undefined; }
})();

const REGISTRY_URL = SOLVER_REGISTRY_URL ?? defaultRegistryUrls(NETWORK)[0];

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
    // Both, and the fallback must be x-only. No mutinynet market advertises an
    // emulator key of its own, so without the fallback the rendezvous selects no
    // market and the rail is silently unavailable -- and passing the 33-byte
    // compressed key fails the same way, which reads as "no solver" rather than
    // as a key of the wrong shape.
    ...(EMULATOR_HEX
      ? { emulatorPubkey: EMULATOR_HEX, fallbackEmulatorPubkey: toXOnly(hex.decode(EMULATOR_HEX), "emulator") }
      : {}),
    decodeInvoice: invoiceFactsFromBolt11,
    discover: () => discoverMarkets({ network: NETWORK, registryUrl: REGISTRY_URL }),
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
