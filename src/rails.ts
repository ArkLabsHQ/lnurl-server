// Receive rails: the pluggable backends behind one LN address.
//
// One address can be paid over several transports, and each one is a rail:
// interactive lightning (the wallet live SSE session hands back a BOLT11),
// the solver-mediated offline swap (the payer pays a BOLT11 hold invoice and the
// covenant pays arkade BTC to the user address), the direct arkade destination
// (the payer pays arkade BTC straight to an address), and covenant destinations
// (per-payment covenant addresses derived for the arkade rail).
//
// The registry below is the only place that names the rails. Adding a transport
// (assets, stablecoin swaps, ...) is a new entry here plus its callback branch:
// the payRequest advertising, the callback gating, the per-address policy, and
// the admin API/UI all key off RAIL_IDS.
//
// Reserved but not valid yet: "onchain" (onchain BTC -> arkade BTC, another
// offline-receive rail in the same family as the offline swap: solver quote +
// covenant claim, settling while the wallet is offline). Wire it to a creator
// like OfflineSwapCreator plus the covenant destinations when the SDK exposes
// it; no plumbing changes are needed beyond a new entry here.

import type { PaymentOption } from "./payment-options.js";

/** Every receive rail the server knows. The order is the advertise order. */
export const RAIL_IDS = ["interactive-lightning", "offline-swap", "arkade", "covenant"] as const;

/** A backend that can satisfy a receive on an LN address. */
export type RailId = (typeof RAIL_IDS)[number];

export function isRailId(value: unknown): value is RailId {
  return typeof value === "string" && (RAIL_IDS as readonly string[]).includes(value);
}

export interface RailDef {
  id: RailId;
  label: string;
  /** Operator-facing: what this rail does and what it needs. */
  description: string;
  /** The LUD-XX paymentOption id this rail answers to, if the payer selects it. */
  paymentOption: string | null;
  /** Payer-facing leg -> receiver-side leg, for the swap-family rails. */
  direction: string | null;
}

export const RAIL_DEFS: Record<RailId, RailDef> = {
  "interactive-lightning": {
    id: "interactive-lightning",
    label: "Interactive Lightning",
    description: "The wallet live session provides the BOLT11 itself (online receive).",
    paymentOption: "lightning",
    direction: null,
  },
  "offline-swap": {
    id: "offline-swap",
    label: "Offline swap",
    description: "Solver-mediated receive while the wallet is offline: the payer pays a BOLT11 hold invoice, the covenant pays arkade BTC.",
    paymentOption: "lightning",
    direction: "bolt11->arkade-btc",
  },
  arkade: {
    id: "arkade",
    label: "Arkade destination",
    description: "The payer pays arkade BTC directly to the registered Arkade identity; settlement is observed on the indexer.",
    paymentOption: "arkade",
    direction: null,
  },
  covenant: {
    id: "covenant",
    label: "Covenant destinations",
    description: "Per-payment covenant addresses for the arkade rail so concurrent payments are told apart by script.",
    paymentOption: "arkade",
    direction: null,
  },
};

/** Amount bounds one rail can serve, in millisats. Either half may be absent,
 *  meaning that end is not narrowed beyond the server/domain bound. */
export interface RailLimits {
  minSendable?: number;
  maxSendable?: number;
}

/** Bounds actually offered, after narrowing. */
export interface Bounds {
  min: number;
  max: number;
}

/** Server-level capability inputs. Identity-agnostic: no address needed. */
export interface ServerRailCaps {
  /**
   * Per-rail amount bounds, where the operator configured them or a backend
   * reported them. A rail absent here inherits the server/domain pair.
   *
   * Rails differ in what they can carry — a covenant destination is bounded by
   * dust and VTXO shape, a solver-mediated swap by whatever the solver quotes —
   * so one global pair has to be either dishonest or the narrowest common
   * denominator. This lets each rail state its own.
   */
  limits?: Partial<Record<RailId, RailLimits>>;
  /** An offline-swap creator is wired (solver transport + claim path configured). */
  offlineSwapCreator: boolean;
  /** Solver discovery currently holds a usable lightning-receive candidate. */
  discoveryReady: boolean;
  /** Why discovery is not ready (surfaced verbatim in per-request errors). */
  discoveryReason?: string;
  /** Arkade indexer base URL (settlement observation for the arkade rail). */
  arkServerUrl?: string;
  /** A covenant destination provider is wired. */
  covenantDestinations: boolean;
}

/** Server-level state of one rail: configured in this process or not. */
export interface ServerRailState {
  id: RailId;
  label: string;
  description: string;
  configured: boolean;
  ready: boolean;
  reason?: string;
}

/** Describe every rail at the server level (for GET /admin/api/rails). */
export function describeServerRails(caps: ServerRailCaps): ServerRailState[] {
  const discoveryReason = caps.discoveryReason ?? "no usable lightning-receive solver cards";
  const states: ServerRailState[] = [
    {
      id: "interactive-lightning",
      label: RAIL_DEFS["interactive-lightning"].label,
      description: RAIL_DEFS["interactive-lightning"].description,
      configured: true,
      ready: true,
    },
    {
      id: "offline-swap",
      label: RAIL_DEFS["offline-swap"].label,
      description: RAIL_DEFS["offline-swap"].description,
      configured: caps.offlineSwapCreator,
      ready: caps.offlineSwapCreator && caps.discoveryReady,
    },
    {
      id: "arkade",
      label: RAIL_DEFS.arkade.label,
      description: RAIL_DEFS.arkade.description,
      configured: Boolean(caps.arkServerUrl),
      ready: Boolean(caps.arkServerUrl),
    },
    {
      id: "covenant",
      label: RAIL_DEFS.covenant.label,
      description: RAIL_DEFS.covenant.description,
      configured: caps.covenantDestinations,
      ready: caps.covenantDestinations,
    },
  ];
  if (!caps.offlineSwapCreator) {
    states[1].reason = "offline receive is not configured (needs ARK_SERVER_URL plus COVCLAIMD_URL or OFFLINE_SELF_CLAIM)";
  } else if (!caps.discoveryReady) {
    states[1].reason = "offline receive unavailable: " + discoveryReason;
  }
  if (!caps.arkServerUrl) {
    states[2].reason = "settlement observation needs ARK_SERVER_URL";
  }
  if (!caps.covenantDestinations) {
    states[3].reason = "per-payment destinations need OFFLINE_COVENANT_DESTINATIONS=true";
  }
  return states;
}

/** The address fields rail resolution depends on. */
export interface RailAddress {
  arkadeAddress: string | null;
  claimPublicKey: string | null;
  /** Rail ids the operator disabled for this address (per-LNURL policy). */
  disabledRails: readonly unknown[];
}

/** Per-address state of one rail: operator policy x server capability x identity. */
export interface AddressRailState {
  id: RailId;
  label: string;
  enabled: boolean;
  available: boolean;
  reason?: string;
}

function disabledSet(address: RailAddress): Set<string> {
  const out = new Set<string>();
  for (const entry of address.disabledRails ?? []) {
    if (typeof entry === "string" && isRailId(entry)) out.add(entry);
  }
  return out;
}

/** Normalize a caller-supplied disabled-rails list; throws on unknown ids. */
export function normalizeDisabledRails(value: unknown): RailId[] {
  if (!Array.isArray(value)) throw new Error("disabledRails must be an array of rail ids");
  const out: RailId[] = [];
  for (const entry of value) {
    if (!isRailId(entry)) throw new Error("unknown rail id: " + JSON.stringify(entry) + " (known: " + RAIL_IDS.join(", ") + ")");
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/** Parse the DB JSON column; unknown/corrupt entries are dropped, never fatal. */
export function parseDisabledRails(value: unknown): RailId[] {
  if (Array.isArray(value)) return value.filter(isRailId);
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(isRailId) : [];
  } catch {
    return [];
  }
}

export function serializeDisabledRails(rails: readonly RailId[]): string {
  return JSON.stringify([...rails]);
}

/** Effective per-address rail states: policy, then capability, then identity. */
export function effectiveRails(address: RailAddress, caps: ServerRailCaps): AddressRailState[] {
  const disabled = disabledSet(address);
  const hasIdentity = Boolean(address.arkadeAddress && address.claimPublicKey);
  const noIdentityReason = "address has no registered Arkade identity";
  const discoveryReason = caps.discoveryReason ?? "no usable lightning-receive solver cards";
  const interactive: AddressRailState = {
    id: "interactive-lightning",
    label: RAIL_DEFS["interactive-lightning"].label,
    enabled: !disabled.has("interactive-lightning"),
    available: !disabled.has("interactive-lightning"),
  };
  if (!interactive.enabled) interactive.reason = "disabled for this address";
  const offline: AddressRailState = {
    id: "offline-swap",
    label: RAIL_DEFS["offline-swap"].label,
    enabled: !disabled.has("offline-swap"),
    available: !disabled.has("offline-swap") && hasIdentity && caps.offlineSwapCreator && caps.discoveryReady,
  };
  if (!offline.enabled) offline.reason = "disabled for this address";
  else if (!hasIdentity) offline.reason = noIdentityReason;
  else if (!caps.offlineSwapCreator) offline.reason = "offline receive is not configured";
  else if (!caps.discoveryReady) offline.reason = "offline receive unavailable: " + discoveryReason;
  const arkade: AddressRailState = {
    id: "arkade",
    label: RAIL_DEFS.arkade.label,
    enabled: !disabled.has("arkade"),
    available: !disabled.has("arkade") && hasIdentity,
  };
  if (!arkade.enabled) arkade.reason = "disabled for this address";
  else if (!hasIdentity) arkade.reason = noIdentityReason;
  const covenant: AddressRailState = {
    id: "covenant",
    label: RAIL_DEFS.covenant.label,
    enabled: !disabled.has("covenant"),
    available: !disabled.has("covenant") && hasIdentity && caps.covenantDestinations,
  };
  if (!covenant.enabled) covenant.reason = "disabled for this address";
  else if (!hasIdentity) covenant.reason = noIdentityReason;
  else if (!caps.covenantDestinations) covenant.reason = "covenant destinations are not configured";
  return [interactive, offline, arkade, covenant];
}

/** Narrow `base` by one rail's configured bounds. Never widens: a rail cannot
 *  offer more than the server or domain already allows. */
export function railBounds(rail: RailId, caps: ServerRailCaps, base: Bounds): Bounds {
  const limits = caps.limits?.[rail];
  if (!limits) return base;
  return {
    min: Math.max(base.min, limits.minSendable ?? base.min),
    max: Math.min(base.max, limits.maxSendable ?? base.max),
  };
}

/**
 * The bounds a `paymentOption` can be honoured at, across every available rail
 * answering it.
 *
 * Two rails share each option — `lightning` is served by a live interactive
 * session or, failing that, the offline swap; `arkade` by the direct
 * destination or a per-payment covenant one. Which one serves is decided at
 * callback time, and a session can drop in between, so the advertised range is
 * the intersection: the widest range every candidate rail can honour. Being
 * conservative under-advertises a rail that would have taken more, which is the
 * better failure than quoting a payer an amount that is refused after they
 * committed to it.
 *
 * Returns `undefined` when no available rail answers the option.
 */
export function optionBounds(
  optionId: string,
  address: RailAddress,
  caps: ServerRailCaps,
  base: Bounds,
): Bounds | undefined {
  const available = effectiveRails(address, caps).filter((state) => state.available);
  const serving = available.filter((state) => RAIL_DEFS[state.id].paymentOption === optionId);
  if (serving.length === 0) return undefined;
  return serving.reduce<Bounds>((acc, state) => {
    const bounds = railBounds(state.id, caps, base);
    return { min: Math.max(acc.min, bounds.min), max: Math.min(acc.max, bounds.max) };
  }, base);
}

/** Options advertised in the LUD-06 payRequest for an address. When `base` is
 *  supplied each option carries the bounds it can actually be honoured at. */
export function advertisedRailOptions(address: RailAddress, caps?: ServerRailCaps, base?: Bounds): PaymentOption[] {
  // Without server caps (unit scope) keep the historical rule: an Arkade
  // identity offers both options, otherwise the address stays pure LUD-06.
  if (!caps) {
    if (!address.arkadeAddress) return [];
    return [
      { id: "lightning", type: "lightning" },
      { id: "arkade", type: "arkade" },
    ];
  }
  // paymentOptions is emitted only when there is a non-lightning option to offer;
  // otherwise the address stays pure LUD-06 even though lightning may serve.
  const states = new Map(effectiveRails(address, caps).map((s) => [s.id, s]));
  if (!states.get("arkade")?.available) return [];
  const options: PaymentOption[] = [];
  if (states.get("interactive-lightning")?.available || states.get("offline-swap")?.available) {
    options.push({ id: "lightning", type: "lightning" });
  }
  options.push({ id: "arkade", type: "arkade" });
  if (!base) return options;
  // Only emitted where a rail actually narrows the pair, so an operator who
  // configured no rail limits sees the payRequest they saw before.
  return options.map((option) => {
    const bounds = optionBounds(option.id, address, caps, base);
    if (!bounds) return option;
    return {
      ...option,
      ...(bounds.min !== base.min ? { minSendable: bounds.min } : {}),
      ...(bounds.max !== base.max ? { maxSendable: bounds.max } : {}),
    };
  });
}