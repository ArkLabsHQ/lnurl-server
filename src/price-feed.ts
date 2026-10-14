// Price feeds behind the LUD-XX paymentQuote seam. The feed contract and the exact
// decimal math are ported from intent-solver's solver-core (core/priceFeed.ts,
// price/feed.ts): one URL per unit plus an RFC 6901 pointer to the price, read as an
// exact decimal, never a float. solver-core is not published, so it is copied here.

import { QuoteError } from "./errors.js";
import type { Logger } from "./logger.js";
import type { PaymentQuote, QuoteProvider, Unit } from "./quote-provider.js";

/** An exact positive decimal: mantissa / 10^scale. */
export interface Price {
  mantissa: bigint;
  scale: number;
}

/** One quotable unit. The feed answers in this unit per ONE WHOLE bitcoin. */
export interface PriceFeedUnit {
  code: string;
  decimals: number;
  feedUrl: string;
  pricePath: string;
}

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;
/** Millisats per whole bitcoin, as a decimal exponent. */
const MSAT_DECIMALS = 11;

export function priceFrom(value: unknown): Price {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : null;
  if (text === null) throw new Error(`price must be a number or a numeric string, got ${JSON.stringify(value)}`);
  const match = DECIMAL.exec(text);
  if (!match) throw new Error(`price must be a plain decimal, got ${JSON.stringify(text)}`);
  const [, whole = "", fraction = ""] = match;
  const mantissa = BigInt(whole + fraction);
  if (mantissa <= 0n) throw new Error(`price must be positive, got ${JSON.stringify(text)}`);
  return { mantissa, scale: fraction.length };
}

export function resolvePrice(body: unknown, pointer: string): Price {
  // RFC 6901 § 4: the EMPTY pointer names the whole document, not a key called "".
  if (pointer === "") return priceFrom(body);
  let node: unknown = body;
  for (const raw of pointer.replace(/^\//, "").split("/")) {
    const token = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(node)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= node.length) {
        throw new Error(`price path ${pointer}: out of range index ${JSON.stringify(token)}`);
      }
      node = node[index];
    } else if (typeof node === "object" && node !== null) {
      if (!(token in node)) throw new Error(`price path ${pointer}: no key ${JSON.stringify(token)} in response`);
      node = (node as Record<string, unknown>)[token];
    } else {
      throw new Error(`price path ${pointer}: cannot descend into ${JSON.stringify(token)}`);
    }
  }
  return priceFrom(node);
}

export function validatePricePath(pointer: string): void {
  if (pointer === "") return;
  if (!pointer.startsWith("/")) throw new Error('price path must be a JSON pointer starting with "/"');
  if (pointer.replaceAll("~0", "").replaceAll("~1", "").includes("~")) {
    throw new Error('price path: "~" must be escaped as "~0" or "~1"');
  }
}

/** The pointer for the two feed shapes recognisable from their URL: Binance and CoinGecko. */
export function defaultPricePath(feedUrl: string): string | null {
  if (feedUrl.includes("binance")) return "/price";
  let query: URLSearchParams;
  try {
    query = new URL(feedUrl).searchParams;
  } catch {
    return null;
  }
  const ids = query.get("ids");
  const currencies = query.get("vs_currencies");
  if (!ids || !currencies) return null;
  return `/${ids.split(",")[0]}/${currencies.split(",")[0]}`;
}

/** `amount` of the unit (smallest denomination) in millisats, at `price` units per BTC.
 *  Multiplies before the one division so no precision is lost on the way. */
export function unitToMsat(amount: bigint, price: Price, decimals: number): bigint {
  const numerator = amount * 10n ** BigInt(price.scale) * 10n ** BigInt(MSAT_DECIMALS);
  const denominator = price.mantissa * 10n ** BigInt(decimals);
  const quotient = numerator / denominator;
  // Up: the receiver is quoted a value, and rounding down would deliver less than it.
  return numerator % denominator === 0n ? quotient : quotient + 1n;
}

export async function fetchPrice(unit: PriceFeedUnit, opts: { timeoutMs: number; fetch?: typeof globalThis.fetch }): Promise<Price> {
  const res = await (opts.fetch ?? fetch)(unit.feedUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(opts.timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(`price feed ${unit.feedUrl}: HTTP ${res.status} - ${text.slice(0, 200)}`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // An HTML error page from a proxy in front of the feed lands here.
    throw new Error(`price feed ${unit.feedUrl}: response was not JSON - ${text.slice(0, 200)}`);
  }
  return resolvePrice(body, unit.pricePath);
}

export interface PriceFeedQuotes extends QuoteProvider {
  refresh(): Promise<void>;
  status(): { ok: boolean; detail: string };
}

/** A QuoteProvider over periodically refreshed feeds. Quoting stays synchronous and
 *  never waits on a feed; a unit whose price is older than `staleAfterMs` is neither
 *  advertised nor quoted. */
export function priceFeedQuotes(cfg: {
  units: PriceFeedUnit[];
  staleAfterMs: number;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  logger?: Logger;
}): PriceFeedQuotes {
  const now = cfg.now ?? Date.now;
  const latest = new Map<string, { price: Price; at: number }>();
  const failures = new Map<string, string>();
  const fresh = (code: string): Price | undefined => {
    const hit = latest.get(code);
    return hit && now() - hit.at < cfg.staleAfterMs ? hit.price : undefined;
  };

  return {
    units(paymentOption) {
      if (paymentOption !== undefined && paymentOption !== "lightning") return [];
      return cfg.units.filter((u) => fresh(u.code)).map((u): Unit => ({ code: u.code, decimals: u.decimals }));
    },
    quote(req): PaymentQuote {
      if (req.receiveUnit !== undefined && req.receiveUnit !== "msat") throw new QuoteError("Unsupported receiveUnit");
      let msat: bigint;
      if (req.unit === undefined) msat = BigInt(req.amount);
      else {
        const unit = cfg.units.find((u) => u.code === req.unit);
        if (!unit) throw new QuoteError("Unsupported unit");
        const price = fresh(unit.code);
        if (!price) throw new QuoteError(`${unit.code} rate is unavailable right now`);
        msat = unitToMsat(BigInt(req.amount), price, unit.decimals);
      }
      return {
        requested: { amount: String(req.amount), unit: req.unit ?? "msat" },
        payment: { amount: String(msat), unit: "msat" },
        receive: { amount: String(msat), unit: "msat" },
      };
    },
    async refresh() {
      await Promise.all(cfg.units.map(async (unit) => {
        try {
          latest.set(unit.code, { price: await fetchPrice(unit, { timeoutMs: cfg.timeoutMs ?? 10_000, ...(cfg.fetch ? { fetch: cfg.fetch } : {}) }), at: now() });
          failures.delete(unit.code);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          failures.set(unit.code, reason);
          cfg.logger?.warn("price_feed_failed", { unit: unit.code, reason });
        }
      }));
    },
    status() {
      const stale = cfg.units.filter((u) => !fresh(u.code));
      if (stale.length === 0) return { ok: true, detail: cfg.units.map((u) => u.code).join(", ") };
      return { ok: false, detail: stale.map((u) => `${u.code}: ${failures.get(u.code) ?? "no fresh price"}`).join("; ") };
    },
  };
}
