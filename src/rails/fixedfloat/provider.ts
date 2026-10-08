import type { FfClient } from "./client.js";
import type { FfRates } from "./rates.js";
import type { FfOrderStore } from "../../ff-order-store.js";

/** Who the payer hands their tokens to. The simulator never answers as FixedFloat. */
export interface FfProvider {
  label: "FixedFloat" | "Simulated";
  idPrefix: "ff-" | "ffsim-";
}

export const FIXEDFLOAT: FfProvider = { label: "FixedFloat", idPrefix: "ff-" };
export const SIMULATED: FfProvider = { label: "Simulated", idPrefix: "ffsim-" };

/** The deposit window assumed before an order exists. It only grows, to the longest one
 *  the provider has granted, so a setting that is too short costs one order, not one per payer. */
export class DepositWindow {
  private observed = 0;
  constructor(private configured: number) {}
  seconds(): number {
    return Math.max(this.configured, this.observed);
  }
  /** Returns true when this grant raised the window. */
  observe(seconds: number): boolean {
    if (seconds <= this.seconds()) return false;
    this.observed = seconds;
    return true;
  }
}

/** The token-deposit rail as the public server sees it. */
export interface FixedFloatDeps {
  provider: FfProvider;
  rates: Pick<FfRates, "snapshot">;
  client: FfClient;
  orders: FfOrderStore;
  window: DepositWindow;
  /** Seconds the provider may need after a deposit to pay the invoice. */
  settleMarginSeconds: number;
  maxOpenOrders: number;
}
