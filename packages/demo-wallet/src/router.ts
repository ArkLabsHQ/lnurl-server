import { arkRail, createDefaultPaymentRouter, type PaymentRouter, type Wallet } from "@arkade-os/sdk";
import { createLnurlClient } from "@arkade-os/lnurl-client";
import { lnurlRails } from "@arkade-os/lnurl-client/arkade";

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
export function createRouter(wallet: Wallet): PaymentRouter {
  const router = createDefaultPaymentRouter(wallet);
  for (const rail of lnurlRails({ client: createLnurlClient(), arkade: arkRail() })) {
    router.use(rail);
  }
  return router;
}
