import type { Network } from "@arkade-os/solver-discovery";
import { matchCaip19Id } from "./caip.js";

// LUD-XX paymentOptions: advertise multiple payment rails on a LUD-06 payRequest
// and resolve the wallet's selection. The rail registry lives in ./rails.js -
// this module keeps the historical identity-only rule for unit scope. The rail-aware
// helpers (advertisedRailOptions etc) live in ./rails.js - prefer those for routes.

/** A payment option advertised in the payRequest (LUD-XX). */
export interface PaymentOption {
  id: string;
  type: string;
  caip19Id?: string;
  available?: boolean;
  /** Whether callback answers for this option carry a LUD-21 `verify` URL; absent means unknown. */
  verifiable?: boolean;
  minSendable?: number;
  maxSendable?: number;
  /** CAIP-19 id of a token option; `type` is its CAIP-2 namespace. */
  asset?: string;
  /** The units[] code a token option is quoted in. */
  unit?: string;
  /** The third party the payer hands funds to, on a custodial rail. */
  provider?: string;
}

/** The address fields the option logic depends on. */
export interface OptionAddress {
  hdReceive?: unknown;
  arkadeAddress: string | null;
  claimPublicKey: string | null;
  /** Arkade boarding address; the onchain rail resolves to it. */
  boardingAddress?: string | null;
  /** Rail ids the operator disabled for this address. */
  disabledRails?: readonly unknown[];
}

/** A token option the provider currently offers. */
export interface TokenRailRef {
  optionId: string;
  ffCode: string;
}

/** Options advertised in the LUD-06 payRequest. Emitted only when there is a
 *  non-lightning option to offer (an Arkade identity); otherwise the address stays
 *  pure LUD-06 and `paymentOptions` is omitted. Add rails here as they land.
 *  States no `verifiable`: without the server's rail caps it is unknown. */
export function advertisedOptions(address: OptionAddress): PaymentOption[] {
  if (!address.arkadeAddress && !address.hdReceive) return [];
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
  | { kind: "hd-destination"; paymentOption: "arkade" }
  | { kind: "fixedfloat"; optionId: string; ffCode: string }
  | { kind: "error"; reason: string };

/** Resolve the wallet's `paymentOption` query value. Extend with new rails here. A token
 *  option resolves only from `tokenRails`, never from its prefix, so an id the provider
 *  stopped offering is refused rather than half-served. */
export function resolvePaymentOption(
  optionId: string | undefined,
  address: OptionAddress,
  tokenRails: readonly TokenRailRef[] = [],
  network?: Network,
): ResolvedPaymentOption {
  // Ids are canonical lowercase; be liberal about the case payers send.
  const raw = optionId?.toLowerCase();
  let id = raw;
  if (raw?.includes(":")) {
    if (!network) return { kind: "error", reason: "Unsupported paymentOption" };
    const match = matchCaip19Id(raw, network);
    if (match.kind === "wrong-network") {
      return { kind: "error", reason: `paymentOption settles on ${match.got}, this service settles on ${network}` };
    }
    if (match.kind === "unknown") return { kind: "error", reason: "Unsupported paymentOption" };
    id = match.type;
  }
  if (id === undefined || id === "lightning") return { kind: "lightning" };
  if (id === "arkade") {
    if (address.hdReceive) return { kind: "hd-destination", paymentOption: "arkade" };
    return address.arkadeAddress
      ? { kind: "destination", paymentOption: "arkade", paymentDestination: address.arkadeAddress }
      : { kind: "error", reason: "Unsupported paymentOption" };
  }
  if (id === "onchain") {
    return address.boardingAddress && !address.hdReceive
      ? { kind: "destination", paymentOption: "onchain", paymentDestination: address.boardingAddress }
      : { kind: "error", reason: "Unsupported paymentOption" };
  }
  const token = tokenRails.find((rail) => rail.optionId === id);
  if (token && (address.hdReceive || (address.arkadeAddress && address.claimPublicKey))) {
    if (address.disabledRails?.includes("fixedfloat")) {
      return { kind: "error", reason: `paymentOption ${token.optionId} is disabled for this address` };
    }
    return { kind: "fixedfloat", optionId: token.optionId, ffCode: token.ffCode };
  }
  return { kind: "error", reason: "Unsupported paymentOption" };
}
