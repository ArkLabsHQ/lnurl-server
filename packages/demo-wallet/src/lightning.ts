import type { IWallet, PaymentRail, PaymentRequest } from "@arkade-os/sdk";
import { createSwapClient, IndexedDbAssetSwapRepository, lightningRail, type RfqTransportFactory, type SwapClient } from "@arkade-os/swap";
import { attesting } from "@arkade-os/swap/advanced";
import { httpTransport } from "@arkade-os/swap/protocol";
import { EMULATOR_PUBKEY, NETWORK, SOLVER_REGISTRY_URL, SOLVER_RFQ_HTTP_URL } from "./config.js";
import { invoiceSats } from "./send-amount.js";

/** Regtest only: its card's solver key is a fixture, so the responder check could prove nothing there. */
export function rfqTransportFor(network: string, httpUrl: string | undefined): RfqTransportFactory | undefined {
  if (network !== "regtest" || !httpUrl) return undefined;
  return (rendezvous) => attesting(httpTransport(httpUrl), rendezvous.solverPubkey);
}

export function createSwaps(wallet: IWallet): SwapClient {
  const transportFor = rfqTransportFor(NETWORK, SOLVER_RFQ_HTTP_URL);
  return createSwapClient({
    wallet,
    repository: new IndexedDbAssetSwapRepository(),
    ...(SOLVER_REGISTRY_URL ? { discovery: { registryUrl: SOLVER_REGISTRY_URL } } : {}),
    ...(EMULATOR_PUBKEY ? { emulatorPubkey: EMULATOR_PUBKEY } : {}),
    ...(transportFor ? { transportFor } : {}),
  });
}

const unrestated = (req: PaymentRequest): PaymentRequest => {
  if (req.amount === undefined || req.amount !== invoiceSats(req.raw)) return req;
  const { amount: _restated, ...rest } = req;
  return rest;
};

/** v2 refuses an amount the invoice already states, even an equal one, and `available()` only peeks at loaded markets. */
export function createLightningRail(client: SwapClient): PaymentRail {
  const rail = lightningRail(client);
  return {
    id: rail.id,
    match: (req, ctx) => rail.match(req, ctx),
    available: async (req, ctx) => {
      await client.markets();
      return rail.available?.(unrestated(req), ctx) ?? true;
    },
    quote: (req, ctx) => rail.quote(unrestated(req), ctx),
  };
}
