// Solver discovery from a solver-registry index (see arkade-os/solver-registry). The
// index is a flat, fee-sorted list of markets; corridor markets carry the RFQ
// rendezvous (discovery_pubkey + transports) self-authenticated by the card's sig.
// We filter to the lightning corridor and take the cheapest card — registry curation
// is a convenience, not a trust anchor: the covenant enforces the trade's terms
// regardless of which solver we talk to.

/** A registry-index market entry for the lightning corridor. Amounts land in sats. */
export interface CorridorCard {
  name: string;
  discoveryPubkey: string;
  relays: string[];
  feeBps: number;
  /** Bounds on the corridor's LIGHTNING leg (the quote side): what the payer pays. */
  minSat: number;
  maxSat: number;
}

interface IndexMarket {
  quote_corridor?: unknown;
  fee_bps?: unknown;
  min_quote_amount?: unknown;
  max_quote_amount?: unknown;
  solver?: unknown;
  discovery_pubkey?: unknown;
  transports?: { nostr?: { relays?: unknown } };
}

function asCard(m: IndexMarket): CorridorCard | null {
  if (m.quote_corridor !== "lightning") return null;
  if (typeof m.discovery_pubkey !== "string" || !/^[0-9a-f]{64}$/i.test(m.discovery_pubkey)) return null;
  const relays = m.transports?.nostr?.relays;
  // The registry schema permits ws:// (regtest/dev relays terminate no TLS).
  if (!Array.isArray(relays) || !relays.length || !relays.every((r) => typeof r === "string" && /^wss?:\/\//.test(r))) return null;
  const minSat = Number(m.min_quote_amount);
  const maxSat = Number(m.max_quote_amount);
  if (!Number.isFinite(minSat) || !Number.isFinite(maxSat) || minSat < 0 || maxSat < minSat) return null;
  return {
    name: typeof m.solver === "string" ? m.solver : m.discovery_pubkey.slice(0, 8),
    discoveryPubkey: m.discovery_pubkey.toLowerCase(),
    relays: relays as string[],
    feeBps: Number(m.fee_bps) || 0,
    minSat,
    maxSat,
  };
}

/** Fetch a registry index and pick the lowest-fee lightning-corridor card.
 *  Returns null when the index serves no usable lightning corridor.
 *  The fetch is time-bounded: a hung registry must not stall startup forever. */
export async function discoverLightningCorridor(
  registryUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<CorridorCard | null> {
  const res = await fetchImpl(registryUrl, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`solver registry index: HTTP ${res.status}`);
  const index = (await res.json()) as { markets?: unknown };
  if (!Array.isArray(index.markets)) throw new Error("solver registry index: no markets array");
  const cards = (index.markets as IndexMarket[]).map(asCard).filter((c): c is CorridorCard => c !== null);
  cards.sort((a, b) => a.feeBps - b.feeBps);
  return cards[0] ?? null;
}
