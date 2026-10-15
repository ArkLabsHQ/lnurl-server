import { createGuardedFetch } from "../guarded-fetch.js";
import { fetchPrice, formatPrice, priceFeedQuotes, quoteUnitFrom, type PriceFeedQuotes, type PriceFeedUnit, type QuoteUnitStatus } from "../price-feed.js";
import type { QuoteUnitsRepo } from "../db/repositories/quote-units.js";
import type { Logger } from "../logger.js";

export interface QuoteUnitView extends QuoteUnitStatus {
  /** An admin unit replacing the QUOTE_UNITS one of the same code; deleting it restores that one. */
  overridesEnv: boolean;
}

export interface QuoteUnitInput {
  decimals: number;
  feedUrl: string;
  pricePath?: string | undefined;
}

export interface QuoteUnits {
  provider: PriceFeedQuotes;
  list(): QuoteUnitView[];
  /** Validates, reads the feed once (refusing one that does not answer), then stores and serves it. */
  save(code: string, input: QuoteUnitInput): Promise<QuoteUnitView>;
  /** False when there is no admin unit of that code. */
  remove(code: string): Promise<boolean>;
  preview(input: Omit<QuoteUnitInput, "decimals">): Promise<string>;
  refresh(): Promise<void>;
}

/** QUOTE_UNITS env units, with admin units added on top: an admin unit of the same code wins. */
export function createQuoteUnits(cfg: {
  envUnits: PriceFeedUnit[];
  repo: Pick<QuoteUnitsRepo, "list" | "upsert" | "delete">;
  staleAfterMs: number;
  logger?: Logger;
  fetch?: typeof globalThis.fetch;
  guardedFetch?: typeof globalThis.fetch;
}): QuoteUnits {
  const guardedFetch = cfg.guardedFetch ?? createGuardedFetch();
  const envCodes = new Set(cfg.envUnits.map((u) => u.code));
  const merged = (): PriceFeedUnit[] => {
    const admin = cfg.repo.list();
    const byCode = new Map(admin.map((u) => [u.code, u]));
    return [...cfg.envUnits.map((u) => byCode.get(u.code) ?? u), ...admin.filter((u) => !envCodes.has(u.code))];
  };
  const provider = priceFeedQuotes({
    units: merged(),
    staleAfterMs: cfg.staleAfterMs,
    guardedFetch,
    ...(cfg.fetch ? { fetch: cfg.fetch } : {}),
    ...(cfg.logger ? { logger: cfg.logger } : {}),
  });
  const view = (s: QuoteUnitStatus): QuoteUnitView => ({ ...s, overridesEnv: s.source === "admin" && envCodes.has(s.code) });
  const list = () => provider.snapshot().map(view);

  return {
    provider,
    list,
    async save(code, input) {
      const unit: PriceFeedUnit = { ...quoteUnitFrom({ code, ...input }), source: "admin" };
      await fetchPrice(unit, { timeoutMs: 10_000, fetch: guardedFetch });
      cfg.repo.upsert(unit);
      provider.setUnits(merged());
      await provider.refresh();
      return list().find((u) => u.code === unit.code)!;
    },
    async remove(code) {
      if (!cfg.repo.delete(code.trim().toUpperCase())) return false;
      provider.setUnits(merged());
      await provider.refresh();
      return true;
    },
    async preview(input) {
      const unit = { ...quoteUnitFrom({ code: "PREVIEW", decimals: 0, ...input }), source: "admin" as const };
      return formatPrice(await fetchPrice(unit, { timeoutMs: 10_000, fetch: guardedFetch }));
    },
    refresh: () => provider.refresh(),
  };
}
