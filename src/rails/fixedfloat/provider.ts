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

/** The token-deposit rail as the public server sees it. */
export interface FixedFloatDeps {
  provider: FfProvider;
  rates: Pick<FfRates, "snapshot">;
  client: FfClient;
  orders: FfOrderStore;
  /** Seconds the provider may need after a deposit to pay the invoice. */
  settleMarginSeconds: number;
  /** The shortest deadline a payer is handed; less, and the request is refused. */
  minPayWindowSeconds: number;
  maxOpenOrders: number;
}
