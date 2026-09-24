import { readFile } from "node:fs/promises";
import {
  DEFAULT_MAX_AGE_SECONDS,
  discover,
  marketCorridor,
  sideLimits,
  validateCard,
  type DiscoveredMarket,
  type FetchLike,
  type Network,
  type SourceReport,
} from "@arkade-os/solver-discovery";
import { solverLightningRendezvous } from "@arkade-os/swap";
import type { SolverCardsRepo } from "./db/repositories/solver-cards.js";
import type { SolverRegistryCacheRepo } from "./db/repositories/solver-registry-cache.js";
import { UpstreamError } from "./errors.js";

const DEFAULT_REFRESH_MS = 10 * 60_000;
const MAX_CACHE_AGE_MS = DEFAULT_MAX_AGE_SECONDS * 1000;

// A stand-in pin, because only a live request holds the covenant's emulator key:
// every other clause of the SDK rule still decides, and a card pinning some other
// key contributes no range rather than one we could not honour.
const ANY_EMULATOR = new Uint8Array(32).fill(1);

type CardStore = Pick<SolverCardsRepo, "listEnabled">;
type CacheStore = Pick<SolverRegistryCacheRepo, "get" | "put">;

export interface SolverCandidate {
  name: string;
  market: DiscoveredMarket;
  discoveryPubkey: string;
  relays: string[];
  source: string;
  sourceType: "registry" | "local";
}

export interface DiscoverySourceStatus extends SourceReport {
  cache?: "fresh" | "expired";
}

/** Sat bounds on the payer's lightning leg, before the server/domain envelope. */
export interface ReceiveBounds {
  minSat: number;
  maxSat: number;
}

export interface DiscoveryStatus {
  network: Network;
  ready: boolean;
  generation: number;
  refreshedAt: number | null;
  nextRefreshAt: number | null;
  candidateCount: number;
  receiveBounds?: ReceiveBounds;
  sources: DiscoverySourceStatus[];
  warnings: string[];
  reason?: string;
}

export interface DiscoveryServiceOptions {
  network: Network;
  registryUrls?: string[];
  cardsFile?: string;
  cardStore: CardStore;
  cacheStore: CacheStore;
  fetchImpl?: FetchLike;
  readFile?: (path: string) => Promise<string>;
  now?: () => number;
  refreshIntervalMs?: number;
}

interface Snapshot {
  generation: number;
  candidates: SolverCandidate[];
  refreshedAt: number;
  expiresAt: number;
}

export class DiscoveryService {
  private readonly now: () => number;
  private readonly readFile: (path: string) => Promise<string>;
  private readonly refreshIntervalMs: number;
  private readonly upstreamFetch: FetchLike;
  private fileCards: unknown[] = [];
  private snapshot: Snapshot | null = null;
  private latestSources: DiscoverySourceStatus[] = [];
  private latestWarnings: string[] = [];
  private refreshing: Promise<void> | null = null;
  private refreshQueued = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextRefreshAt: number | null = null;
  private cacheUsed = new Set<string>();
  private cacheExpired = new Set<string>();
  private fetchedBodies = new Map<string, string>();

  constructor(private options: DiscoveryServiceOptions) {
    this.now = options.now ?? Date.now;
    this.readFile = options.readFile ?? ((path) => readFile(path, "utf8"));
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
    this.upstreamFetch = options.fetchImpl ?? (fetch as FetchLike);
  }

  async start(): Promise<void> {
    this.fileCards = await this.loadFileCards();
    await this.refresh();
    // Solver discovery is optional: starting without candidates keeps the
    // interactive LNURL relay ready; sessionless offline callbacks fail loudly
    // per request instead. See src/rails.ts.
    if (this.refreshIntervalMs > 0) {
      this.nextRefreshAt = this.now() + this.refreshIntervalMs;
      this.timer = setInterval(() => {
        this.nextRefreshAt = this.now() + this.refreshIntervalMs;
        void this.refresh();
      }, this.refreshIntervalMs);
      this.timer.unref?.();
    }
  }

  refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      // The shared outer promise includes every queued do/while iteration, so
      // callers observe the refresh they requested rather than a stale snapshot.
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        this.refreshQueued = false;
        await this.doRefresh();
      } while (this.refreshQueued);
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.nextRefreshAt = null;
  }

  /**
   * The candidates that can fund a lightning receive of `amountSat`.
   *
   * Matching is delegated to the SDK's rendezvous rule rather than a leg-id
   * query, because the registry publishes corridor cards in the legacy v0
   * shape (`base_asset.id: "btc"` + `quote_corridor: "lightning"`), whose
   * `marketLegKey` renders as `arkade:btc`/`lightning:btc` — so a query naming
   * only the canonical CAIP-19 ids matches none of them, and the rail went
   * dark for every solver that publishes that way. The SDK rule accepts both
   * forms and additionally rejects a market whose base leg is not BTC, which a
   * corridor check alone cannot tell.
   *
   * All candidates are filtered, not just the best, so the caller keeps its
   * failover list. `emulatorPubkey` is required: the covenant commits to the
   * emulator's key, so a quote from a deployment we have no key for could only
   * fund a lockup nothing can claim.
   */
  selectLightningReceive(amountSat: number, emulatorPubkey: Uint8Array): SolverCandidate[] {
    if (!Number.isSafeInteger(amountSat) || amountSat <= 0) return [];
    return (this.snapshot?.candidates ?? []).filter((candidate) =>
      // The payout side has to be receive-capable, which the rendezvous rule
      // does not ask — it only sizes the payer's side.
      sideLimits(candidate.market, "base") !== null &&
      solverLightningRendezvous([candidate.market], amountSat, emulatorPubkey) !== undefined,
    );
  }

  status(): DiscoveryStatus {
    const snapshot = this.snapshot && this.snapshot.expiresAt > this.now() ? this.snapshot : null;
    const receiveBounds = this.receiveRange(snapshot?.candidates ?? []);
    return {
      network: this.options.network,
      ready: Boolean(snapshot?.candidates.length),
      generation: snapshot?.generation ?? 0,
      refreshedAt: snapshot?.refreshedAt ?? null,
      nextRefreshAt: this.nextRefreshAt,
      candidateCount: snapshot?.candidates.length ?? 0,
      ...(receiveBounds ? { receiveBounds } : {}),
      sources: this.latestSources,
      warnings: this.latestWarnings,
      ...(!snapshot?.candidates.length ? { reason: "no usable lightning-receive solver cards" } : {}),
    };
  }

  /**
   * The union of the cards' payer-side ranges, not their intersection: `create`
   * walks every candidate the selector returns, so an amount one card refuses is
   * still served by the next, and two disjoint cards would intersect to nothing.
   * A gap between disjoint cards is all a single LNURL pair cannot express, and
   * an amount landing in one is refused at the callback with a reason.
   */
  private receiveRange(candidates: readonly SolverCandidate[]): ReceiveBounds | undefined {
    let bounds: ReceiveBounds | undefined;
    for (const candidate of candidates) {
      const payer = sideLimits(candidate.market, "quote");
      if (!payer || sideLimits(candidate.market, "base") === null) continue;
      const minSat = Number(payer.min);
      const maxSat = Number(payer.max);
      if (!Number.isSafeInteger(minSat) || !Number.isSafeInteger(maxSat)) continue;
      if (solverLightningRendezvous([candidate.market], minSat, ANY_EMULATOR) === undefined) continue;
      bounds = bounds
        ? { minSat: Math.min(bounds.minSat, minSat), maxSat: Math.max(bounds.maxSat, maxSat) }
        : { minSat, maxSat };
    }
    return bounds;
  }

  private async loadFileCards(): Promise<unknown[]> {
    if (!this.options.cardsFile) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(await this.readFile(this.options.cardsFile));
    } catch (error) {
      throw new Error(`${this.options.cardsFile}: ${error instanceof Error ? error.message : "cannot read card file"}`);
    }
    if (!Array.isArray(parsed)) throw new Error(`${this.options.cardsFile}: expected a JSON array of solver cards`);
    parsed.forEach((card, index) => {
      const result = validateCard(card);
      if (!result.ok) throw new Error(`${this.options.cardsFile}: invalid card ${index}: ${result.errors.join("; ")}`);
    });
    return parsed;
  }

  private async doRefresh(): Promise<void> {
    this.cacheUsed.clear();
    this.cacheExpired.clear();
    this.fetchedBodies.clear();
    const dbCards = this.options.cardStore.listEnabled(this.options.network).map((row) => {
      try { return { card: JSON.parse(row.cardJson), network: this.options.network, label: `db:${row.id}:${row.label}` }; }
      catch { return { card: {}, network: this.options.network, label: `db:${row.id}:${row.label}` }; }
    });
    const fileCards = this.fileCards.map((card, index) => ({
      card,
      network: this.options.network,
      label: `file:${this.options.cardsFile}:${index}`,
    }));
    const result = await discover({
      network: this.options.network,
      registries: this.options.registryUrls,
      localCards: [...dbCards, ...fileCards],
      fetchImpl: this.cacheAwareFetch,
      now: Math.floor(this.now() / 1000),
    });
    const staleSources = new Set(result.sources.filter((source) => source.warnings.some((warning) => /index is stale/.test(warning))).map((source) => source.source));
    for (const source of result.sources) {
      const body = this.fetchedBodies.get(source.source);
      if (source.sourceType === "registry" && source.ok && body && !staleSources.has(source.source)) {
        this.options.cacheStore.put({ url: source.source, network: this.options.network, body, fetchedAt: this.now() });
      }
    }
    const markets = result.markets.filter((market) => !staleSources.has(market.source));
    const candidates = markets.flatMap((market): SolverCandidate[] => {
      if (marketCorridor(market, "base") !== "arkade" || marketCorridor(market, "quote") !== "bolt11") return [];
      const discoveryPubkey = market.discovery_pubkey;
      const relays = market.transports?.nostr?.relays;
      if (!discoveryPubkey || !relays?.length) return [];
      return [{ name: market.solver, market, discoveryPubkey, relays: [...relays], source: market.source, sourceType: market.sourceType }];
    });
    this.latestSources = result.sources.map((source) => ({
      ...source,
      ...(this.cacheUsed.has(source.source) ? { cache: "fresh" as const } : {}),
      ...(this.cacheExpired.has(source.source) ? { cache: "expired" as const } : {}),
    }));
    this.latestWarnings = result.warnings;
    if (!candidates.length) {
      const failedRegistries = new Set(result.sources
        .filter((source) => source.sourceType === "registry" && !source.ok)
        .map((source) => source.source));
      const fallback = this.snapshot?.candidates.filter((candidate) =>
        candidate.sourceType === "registry" && failedRegistries.has(candidate.source)) ?? [];
      const fallbackExpiry = this.snapshot
        ? Math.min(this.snapshot.expiresAt, this.snapshot.refreshedAt + MAX_CACHE_AGE_MS)
        : 0;
      if (this.snapshot && fallback.length && fallbackExpiry > this.now()) {
        this.snapshot = { ...this.snapshot, candidates: fallback, expiresAt: fallbackExpiry };
      } else {
        this.snapshot = null;
      }
      return;
    }
    const hasLocal = candidates.some((candidate) => candidate.sourceType === "local");
    this.snapshot = {
      generation: (this.snapshot?.generation ?? 0) + 1,
      candidates,
      refreshedAt: this.now(),
      expiresAt: hasLocal ? Number.POSITIVE_INFINITY : this.now() + MAX_CACHE_AGE_MS,
    };
  }

  private cacheAwareFetch: FetchLike = async (input, init) => {
    try {
      const response = await this.upstreamFetch(input, init);
      if (!response.ok) throw new UpstreamError(String(input), response.status);
      const body = await response.text();
      this.fetchedBodies.set(input, body);
      return { ok: true, status: response.status, text: async () => body };
    } catch (error) {
      const cached = this.options.cacheStore.get(input, this.options.network);
      if (cached && this.now() - cached.fetchedAt <= MAX_CACHE_AGE_MS) {
        this.cacheUsed.add(input);
        return { ok: true, status: 200, text: async () => cached.body };
      }
      if (cached) this.cacheExpired.add(input);
      throw error;
    }
  };
}
