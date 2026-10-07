import type { FfRates } from "./rates.js";

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
}
