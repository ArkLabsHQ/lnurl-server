import { arkRail, createDefaultPaymentRouter, type PaymentRouter } from "@arkade-os/sdk";
import { createLnurlClient } from "@arkade-os/lnurl-client";
import { lnurlRails } from "@arkade-os/lnurl-client/arkade";
import { createLightningRail } from "./lightning.js";
import type { DemoWallet } from "./wallet.js";

/**
 * Rail order. `lnurl-arkade` outranks `lnurl-lightning` for the reason the
 * router exists: both can serve the same Lightning address, and the Arkade leg
 * delivers the full amount with no counterparty. Changing the policy is this
 * array, not a branch in the send path.
 */
export const RAIL_PRIORITY = ["lnurl-arkade", "ark", "ark-asset", "lnurl-lightning", "solver-lightning", "onchain"];

/**
 * The router the wallet pays through.
 *
 * `createDefaultPaymentRouter` brings `ark`, `ark-asset` and `onchain`; the
 * LNURL rails are registered here because a rail needs a client the SDK does
 * not carry. The payer client needs no `baseUrl` — an address resolves against
 * its own domain, so this routes to any server, not only ours.
 */
export function createRouter(demo: DemoWallet): PaymentRouter {
  const router = createDefaultPaymentRouter(demo.wallet);
  const lightning = createLightningRail();
  // Registered alongside the LNURL rails, not only inside them: a bare BOLT11
  // pasted into the send box is the same corridor without the LNURL hop.
  router.use(lightning);
  for (const rail of lnurlRails({ client: createLnurlClient(), arkade: arkRail(), lightning })) {
    router.use(rail);
  }
  return router;
}
