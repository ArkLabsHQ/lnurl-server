// Which FixedFloat rails can be advertised right now, and at what sat bounds. One
// unauthenticated GET of rates/fixed.xml (no request weight) plus one ccies call.

import type { Logger } from "../../logger.js";
import { FfBudgetError, type FfClient, type FfCurrency } from "./client.js";
import { FF_ASSETS, ffAssetId, type FfAsset, type TokenUnitCode } from "./catalogue.js";

export interface FfRail {
  /** The paymentOption id: the provider's prefix plus the lowercased FixedFloat code. */
  optionId: string;
  ffCode: string;
  /** CAIP-19. */
  asset: string;
  unit: TokenUnitCode;
  decimals: number;
  minSat: number;
  maxSat: number;
}

export interface FfRatesSnapshot {
  rails: FfRail[];
  ready: boolean;
  /** Why it is not ready, verbatim for the rail status. */
  reason?: string;
}

export interface FfRates {
  snapshot(): FfRatesSnapshot;
  refresh(): Promise<void>;
}

export interface RateRow { from: string; to: string; out: number; min: number; max: number }

export function parseRatesXml(xml: string): RateRow[] {
  const rows: RateRow[] = [];
  for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const get = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(item!)?.[1]?.trim();
    // minamount/maxamount carry the currency code after the number: "2.4115271059 USDCARBITRUM".
    const num = (v?: string) => {
      const n = Number(v?.split(/\s+/)[0]);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    };
    const from = get("from");
    const to = get("to");
    const out = num(get("out"));
    const min = num(get("minamount"));
    const max = num(get("maxamount"));
    if (from && to && out && min && max) rows.push({ from, to, out, min, max });
  }
  return rows;
}

export function ffRatesXml(url: string): () => Promise<string> {
  return async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`FixedFloat rates HTTP ${res.status}`);
    return res.text();
  };
}

// Both flags, because ff.io does not say whose side `send` and `recv` describe.
const usable = (c: FfCurrency | undefined): c is FfCurrency => Boolean(c?.send && c.recv);

export function ffRates(cfg: {
  client: Pick<FfClient, "ccies">;
  fetchRatesXml: () => Promise<string>;
  idPrefix: string;
  assets?: Readonly<Record<string, FfAsset>>;
  allow?: readonly string[];
  deny?: readonly string[];
  staleAfterMs: number;
  now?: () => number;
  logger?: Logger;
}): FfRates {
  const now = cfg.now ?? Date.now;
  const assets = cfg.assets ?? FF_ASSETS;
  const allow = cfg.allow ? new Set(cfg.allow) : undefined;
  const deny = new Set(cfg.deny ?? []);
  let rails: FfRail[] = [];
  let okAt: number | undefined;
  let failure: string | undefined;

  const build = (ccies: FfCurrency[], rows: RateRow[]): FfRail[] => {
    const byCode = new Map(ccies.map((c) => [c.code, c]));
    if (!usable(byCode.get("BTCLN"))) throw new Error("FixedFloat cannot send BTCLN right now");
    const toLightning = new Map(rows.filter((r) => r.to === "BTCLN").map((r) => [r.from, r]));
    return Object.entries(assets).flatMap(([code, asset]): FfRail[] => {
      if ((allow && !allow.has(code)) || deny.has(code)) return [];
      const currency = byCode.get(code);
      const row = toLightning.get(code);
      if (!usable(currency) || currency.coin !== asset.unit || !currency.contract || !row) return [];
      const id = ffAssetId(asset, currency.contract);
      // The XML minimum, not price's: it is the higher of the two, and under-advertising
      // beats quoting a payer an amount refused after they committed to it.
      const minSat = Math.ceil(row.min * row.out * 1e8);
      const maxSat = Math.floor(row.max * row.out * 1e8);
      if (!id || !(minSat > 0 && minSat <= maxSat)) return [];
      return [{ optionId: `${cfg.idPrefix}${code.toLowerCase()}`, ffCode: code, asset: id, unit: asset.unit, decimals: asset.decimals, minSat, maxSat }];
    });
  };

  return {
    snapshot() {
      if (failure) return { rails, ready: false, reason: failure };
      if (okAt === undefined) return { rails, ready: false, reason: "FixedFloat rates not loaded yet" };
      const age = now() - okAt;
      if (age >= cfg.staleAfterMs) return { rails, ready: false, reason: `FixedFloat rates are stale (last refreshed ${Math.round(age / 1000)}s ago)` };
      if (rails.length === 0) return { rails, ready: false, reason: "FixedFloat offers none of the allowed currencies right now" };
      return { rails, ready: true };
    },
    async refresh() {
      try {
        const [xml, ccies] = await Promise.all([cfg.fetchRatesXml(), cfg.client.ccies()]);
        rails = build(ccies, parseRatesXml(xml));
        okAt = now();
        failure = undefined;
      } catch (error) {
        // Our own budget or pause refused it: the last snapshot stands, staleness still applies.
        if (error instanceof FfBudgetError) return;
        failure = `FixedFloat rates refresh failed: ${error instanceof Error ? error.message : String(error)}`;
        cfg.logger?.warn("ff_rates_stale", { reason: failure });
      }
    },
  };
}
