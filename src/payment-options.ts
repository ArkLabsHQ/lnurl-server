// LUD-XX paymentOptions: advertise multiple payment rails on a LUD-06 payRequest
// and resolve the wallet's selection. Kept as a small registry so future rails
// (assets, stablecoin<->arkade swaps, ...) slot in as new cases without touching
// the callback plumbing.

/** A payment option advertised in the payRequest (LUD-XX). */
export interface PaymentOption {
  id: string;
  type: string;
  available?: boolean;
  minSendable?: number;
  maxSendable?: number;
}

/** The address fields the option logic depends on. */
export interface OptionAddress {
  arkadeAddress: string | null;
  claimPublicKey: string | null;
}

/** Options advertised in the LUD-06 payRequest. Emitted only when there is a
 *  non-lightning option to offer (an Arkade identity); otherwise the address stays
 *  pure LUD-06 and `paymentOptions` is omitted. Add rails here as they land. */
export function advertisedOptions(address: OptionAddress): PaymentOption[] {
  if (!address.arkadeAddress) return [];
  return [
    { id: "lightning", type: "lightning" },
    { id: "arkade", type: "arkade" },
  ];
}

/** The plan for satisfying a selected `paymentOption`. `lightning` (or absent)
 *  falls through to the existing BOLT11 flow; a rail with a standalone destination
 *  resolves to `destination`; anything unknown/unavailable is an `error`. */
export type ResolvedPaymentOption =
  | { kind: "lightning" }
  | { kind: "destination"; paymentOption: string; paymentDestination: string }
  | { kind: "error"; reason: string };

/** Resolve the wallet's `paymentOption` query value. Extend with new rails here. */
export function resolvePaymentOption(optionId: string | undefined, address: OptionAddress): ResolvedPaymentOption {
  // Ids are canonical lowercase; be liberal about the case payers send.
  const id = optionId?.toLowerCase();
  if (id === undefined || id === "lightning") return { kind: "lightning" };
  if (id === "arkade") {
    return address.arkadeAddress
      ? { kind: "destination", paymentOption: "arkade", paymentDestination: address.arkadeAddress }
      : { kind: "error", reason: "Unsupported paymentOption" };
  }
  return { kind: "error", reason: "Unsupported paymentOption" };
}
