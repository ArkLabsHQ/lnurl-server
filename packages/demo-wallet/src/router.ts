import type { PaymentRouter } from "@arkade-os/sdk";
import { arkadePaymentRouter, DEFAULT_RAIL_PRIORITY } from "@arkade-os/lnurl-client/arkade";
import { createLightningRail } from "./lightning.js";
import type { DemoWallet } from "./wallet.js";

/** The package's order: `lnurl-arkade` outranks `lnurl-lightning` for the same
 *  address, because the Arkade leg delivers the full amount with no counterparty. */
export const RAIL_PRIORITY = DEFAULT_RAIL_PRIORITY;

export function createRouter(demo: DemoWallet): PaymentRouter {
  return arkadePaymentRouter({ wallet: demo.wallet, lightning: createLightningRail() });
}
