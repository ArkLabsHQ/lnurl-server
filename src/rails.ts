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
import type { ServerDeps } from "./server-context.js";

/** Every receive rail the server knows. The order is the advertise order. */
export const RAIL_IDS = ["interactive-lightning", "offline-swap", "arkade", "covenant", "onchain"] as const;

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
  onchain: {
    id: "onchain",
    label: "Onchain boarding",
    description:
      "The payer sends onchain BTC to the owner's Arkade boarding address, which the owner boards into VTXOs themselves. " +
      "Static and unwatched: nothing here observes Bitcoin, so these payments never settle server-side and carry no verify.",
    paymentOption: "onchain",
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

/** A refusal safe to quote to the payer verbatim. Anything else a rail throws
 *  stays generic, because it may name a solver, a key, or this server's wiring. */
export class RailRefusedError extends Error {}

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
    {
      id: "onchain",
      label: RAIL_DEFS.onchain.label,
      description: RAIL_DEFS.onchain.description,
      // Nothing server-side to configure: the destination is the owner's own
      // boarding address, so the capability is always present and whether any
      // given address offers it is decided per address.
      configured: true,
      ready: true,
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
  /** Arkade boarding address; the onchain rail is advertised only when set. */
  boardingAddress?: string | null;
  /** Rail ids the operator disabled for this address (per-LNURL policy). */
  disabledRails: readonly unknown[];
}

/** Per-address state of one rail: operator policy x server capability x identity. */
export interface AddressRailState {
  id: RailId;
  label: string;
  enabled: boolean;
  /**
   * This address has what the rail needs — an Arkade identity, a boarding
   * address. Separate from {@link available}, which also requires the server to
   * be able to serve it right now.
   *
   * The distinction is what LUD-XX's `available: false` means: a rail the
   * address offers but that is currently down is worth advertising as such,
   * because omitting it tells a payer the address does not do this at all and
   * they go elsewhere instead of retrying. A rail the address never set up is
   * genuinely not on offer, and stays omitted.
   */
  applicable: boolean;
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
    applicable: true,
    available: !disabled.has("interactive-lightning"),
  };
  if (!interactive.enabled) interactive.reason = "disabled for this address";
  const offline: AddressRailState = {
    id: "offline-swap",
    label: RAIL_DEFS["offline-swap"].label,
    enabled: !disabled.has("offline-swap"),
    applicable: hasIdentity,
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
    applicable: hasIdentity,
    available: !disabled.has("arkade") && hasIdentity,
  };
  if (!arkade.enabled) arkade.reason = "disabled for this address";
  else if (!hasIdentity) arkade.reason = noIdentityReason;
  const covenant: AddressRailState = {
    id: "covenant",
    label: RAIL_DEFS.covenant.label,
    enabled: !disabled.has("covenant"),
    applicable: hasIdentity,
    available: !disabled.has("covenant") && hasIdentity && caps.covenantDestinations,
  };
  if (!covenant.enabled) covenant.reason = "disabled for this address";
  else if (!hasIdentity) covenant.reason = noIdentityReason;
  else if (!caps.covenantDestinations) covenant.reason = "covenant destinations are not configured";
  // Independent of the Arkade identity on purpose: a boarding address is the
  // owner's own onchain key, so the rail stands or falls on that alone.
  const onchain: AddressRailState = {
    id: "onchain",
    label: RAIL_DEFS.onchain.label,
    enabled: !disabled.has("onchain"),
    applicable: Boolean(address.boardingAddress),
    available: !disabled.has("onchain") && Boolean(address.boardingAddress),
  };
  if (!onchain.enabled) onchain.reason = "disabled for this address";
  else if (!address.boardingAddress) onchain.reason = "address has no registered boarding address";
  return [interactive, offline, arkade, covenant, onchain];
}

/** Rails whose payment lands as a VTXO or a boarding UTXO, so arkd's own floor
 *  binds them regardless of what the operator configured. */
const VTXO_SETTLED: readonly RailId[] = ["arkade", "covenant", "onchain"];

/**
 * Fold what arkd will actually accept into the rails it settles, the way
 * `withSolverRange` folds a solver's quoted market into `offline-swap`.
 *
 * An operator minimum is not the binding one: arkd refuses an output below
 * `dust` (330 sats on mainnet and mutinynet alike), so advertising less hands a
 * payer an amount that cannot land — and on the onchain rail their money is
 * already spent by the time anyone finds out.
 *
 * These rails also settle in whole sats, so a millisat-precision bound is not
 * merely optimistic but unrepresentable; hence the one-sat floor even where dust
 * is unknown, and the maximum rounding down rather than up. The lightning rails
 * are left alone: they carry millisats natively.
 */
export function withVtxoFloors(
  limits: ServerRailCaps["limits"],
  floors: { dustSat?: number; onchainMinSat?: number } = {},
): ServerRailCaps["limits"] {
  const dustFloor = Math.max((floors.dustSat ?? 0) * 1000, 1000);
  const next: Partial<Record<RailId, RailLimits>> = { ...limits };
  for (const rail of VTXO_SETTLED) {
    const own = next[rail];
    const max = own?.maxSendable;
    // Dust is what arkd will accept; onchain is the one rail where that is not
    // the same as what is worth accepting. Delivering it costs the payer a
    // Bitcoin transaction fee that can exceed the payment several times over,
    // and this server has no onchain fee source to work the break-even out per
    // payment, so the floor is policy rather than arithmetic. Never below dust.
    const floor = rail === "onchain" ? Math.max(dustFloor, (floors.onchainMinSat ?? 0) * 1000) : dustFloor;
    next[rail] = {
      minSendable: Math.max(floor, Math.ceil((own?.minSendable ?? 0) / 1000) * 1000),
      ...(max === undefined ? {} : { maxSendable: Math.floor(max / 1000) * 1000 }),
    };
  }
  return next;
}

/** Fold what the discovered solvers will quote into the offline-swap rail's
 *  limits. Both are real caps, so the tighter of the two wins on each end. */
function withSolverRange(
  configured: ServerRailCaps["limits"],
  range?: { minSat: number; maxSat: number },
): ServerRailCaps["limits"] {
  if (!range) return configured;
  const own = configured?.["offline-swap"];
  return {
    ...configured,
    "offline-swap": {
      minSendable: Math.max(range.minSat * 1000, own?.minSendable ?? 0),
      maxSendable: Math.min(range.maxSat * 1000, own?.maxSendable ?? Infinity),
    },
  };
}

/** Which backends this process wired, derived per request rather than frozen at boot:
 *  discovery refreshes on a timer, so a rail going dark or republishing a narrower
 *  range must move the next payRequest. Unknown discovery state (none injected, e.g.
 *  unit scope) assumes ready; the coordinator still fails loudly per request. */
export function currentRailCaps(wiring: Pick<ServerDeps,
  "offlineSwapCreator" | "covenantDestinations" | "solverDiscovery" | "arkServerUrl" | "railLimits" | "arkDustSat" | "onchainMinSat"
> = {}): ServerRailCaps {
  const discoveryStatus = wiring.solverDiscovery?.status();
  // Dust last: it is the protocol's floor, so it must survive whatever the
  // operator and the solver narrowed to, not be averaged with them.
  const limits = withVtxoFloors(withSolverRange(wiring.railLimits, discoveryStatus?.receiveBounds), {
    ...(wiring.arkDustSat ? { dustSat: wiring.arkDustSat } : {}),
    ...(wiring.onchainMinSat ? { onchainMinSat: wiring.onchainMinSat } : {}),
  });
  return {
    offlineSwapCreator: Boolean(wiring.offlineSwapCreator),
    discoveryReady: discoveryStatus?.ready ?? true,
    ...(discoveryStatus?.reason ? { discoveryReason: discoveryStatus.reason } : {}),
    ...(wiring.arkServerUrl ? { arkServerUrl: wiring.arkServerUrl } : {}),
    covenantDestinations: Boolean(wiring.covenantDestinations),
    ...(limits ? { limits } : {}),
  };
}

/** Narrow `base` by one rail's configured bounds. Never widens: a rail cannot
 *  offer more than the server or domain already allows.
 *
 *  A rail configured outside the envelope entirely — a min above the server's
 *  max — yields `min > max` and so refuses every amount. That is deliberate: a
 *  rail that cannot serve anything should serve nothing, and clamping into
 *  range would silently accept amounts the operator meant to exclude. Only the
 *  advertised pair guards against it, because a malformed payRequest is a
 *  different failure from a rail that declines. */
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
 * Returns `undefined` when no available rail answers the option, and also when
 * the candidates do not overlap at all — disjoint rails intersect to `min >
 * max`, which as a payRequest is malformed rather than merely narrow: no amount
 * satisfies it, so every payer's range check refuses everything. That is an
 * operator misconfiguration, and falling back to the server/domain pair keeps
 * the payRequest well-formed while the per-rail check at the callback still
 * refuses honestly.
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
  const intersected = serving.reduce<Bounds>((acc, state) => {
    const bounds = railBounds(state.id, caps, base);
    return { min: Math.max(acc.min, bounds.min), max: Math.min(acc.max, bounds.max) };
  }, base);
  return intersected.min > intersected.max ? undefined : intersected;
}

/**
 * The top-level payRequest pair, which is the lightning rail's bounds rather
 * than the envelope: a payer sending no `paymentOption` resolves to that rail,
 * so quoting them anything wider would be quoting a rail that will not serve
 * them.
 */
export function advertisedBounds(address: RailAddress, caps: ServerRailCaps, base: Bounds): Bounds {
  return optionBounds("lightning", address, caps, base) ?? base;
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
  /** Serving now, or offered-but-down — the two cases worth advertising at all.
   *  A rail the address never set up is neither, and stays omitted. */
  const offered = (...ids: RailId[]): { offer: boolean; available: boolean } => {
    const rails = ids.map((id) => states.get(id)).filter((s): s is AddressRailState => Boolean(s));
    if (rails.some((s) => s.available)) return { offer: true, available: true };
    return { offer: rails.some((s) => s.enabled && s.applicable), available: false };
  };
  const lightning = offered("interactive-lightning", "offline-swap");
  const arkadeState = offered("arkade");
  const onchainState = offered("onchain");
  const arkadeReady = arkadeState.offer;
  const onchainReady = onchainState.offer;
  // paymentOptions exists to name a non-lightning rail; with none to offer the
  // address stays pure LUD-06 even though lightning may still serve it.
  if (!arkadeReady && !onchainReady) return [];
  const options: PaymentOption[] = [];
  // `available` is emitted only when false: LUD-XX says an absent one means true,
  // so stating it on every healthy option would be noise.
  if (lightning.offer) options.push({ id: "lightning", type: "lightning", ...(lightning.available ? {} : { available: false }) });
  if (arkadeReady) options.push({ id: "arkade", type: "arkade", ...(arkadeState.available ? {} : { available: false }) });
  if (onchainReady) options.push({ id: "onchain", type: "onchain", ...(onchainState.available ? {} : { available: false }) });
  if (!base) return options;
  // Emitted relative to the pair the payRequest actually advertises, not to the
  // envelope. A client falls back to the top-level pair for an option that
  // publishes nothing, and the top level is the lightning rail's — so an option
  // that is WIDER than lightning has to say so, or the client refuses amounts
  // the server would accept. Equal to the top level means nothing to emit, so
  // an operator who configured no rail limits sees the payRequest as before.
  const advertised = advertisedBounds(address, caps, base);
  return options.map((option) => {
    const bounds = optionBounds(option.id, address, caps, base);
    if (!bounds) return option;
    return {
      ...option,
      ...(bounds.min !== advertised.min ? { minSendable: bounds.min } : {}),
      ...(bounds.max !== advertised.max ? { maxSendable: bounds.max } : {}),
    };
  });
}