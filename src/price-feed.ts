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
  /** "admin" units were typed into the admin UI and fetch through the SSRF guard. */
  source?: "env" | "admin";
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
  // A list is ambiguous: picking its first entry would price USD off `vs_currencies=eur,usd`.
  if (!ids || !currencies || ids.includes(",") || currencies.includes(",")) return null;
  return `/${ids}/${currencies}`;
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

/** A price is a few hundred bytes; a misconfigured URL can be an order book. */
const MAX_BODY_BYTES = 1_048_576;

async function cappedText(res: Response, feedUrl: string): Promise<string> {
  const tooLarge = () => new Error(`price feed ${feedUrl}: response exceeded ${MAX_BODY_BYTES} bytes`);
  if (!res.body) {
    const text = await res.text();
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw tooLarge();
    return text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      void reader.cancel().catch(() => {});
      throw tooLarge();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export async function fetchPrice(unit: PriceFeedUnit, opts: { timeoutMs: number; fetch?: typeof globalThis.fetch }): Promise<Price> {
  const res = await (opts.fetch ?? fetch)(unit.feedUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(opts.timeoutMs) });
  const text = await cappedText(res, unit.feedUrl);
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

export function formatPrice(price: Price): string {
  const digits = price.mantissa.toString().padStart(price.scale + 1, "0");
  return price.scale === 0 ? digits : `${digits.slice(0, -price.scale)}.${digits.slice(-price.scale)}`;
}

export class QuoteUnitError extends Error {
  constructor(readonly field: "code" | "decimals" | "feedUrl" | "pricePath", message: string) {
    super(message);
  }
}

/** The one validation for a unit, whichever of env or the admin API it came from. */
export function quoteUnitFrom(input: { code: string; decimals: number; feedUrl: string; pricePath?: string | undefined }): PriceFeedUnit {
  const code = input.code.trim().toUpperCase();
  // The code becomes part of env var names.
  if (!/^[A-Z][A-Z0-9]{0,15}$/.test(code)) throw new QuoteUnitError("code", `unit code "${input.code}" must be letters and digits, starting with a letter`);
  if (!Number.isInteger(input.decimals) || input.decimals < 0 || input.decimals > 18) throw new QuoteUnitError("decimals", "decimals must be an integer in 0..18");
  let url: URL;
  try {
    url = new URL(input.feedUrl);
  } catch {
    throw new QuoteUnitError("feedUrl", "feed URL must be an absolute http(s) URL");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new QuoteUnitError("feedUrl", "feed URL must be an absolute http(s) URL without credentials");
  const pricePath = input.pricePath ?? defaultPricePath(input.feedUrl);
  if (pricePath === null) throw new QuoteUnitError("pricePath", `price path is required: it cannot be derived from ${input.feedUrl}`);
  try {
    validatePricePath(pricePath);
  } catch (error) {
    throw new QuoteUnitError("pricePath", (error as Error).message);
  }
  return { code, decimals: input.decimals, feedUrl: input.feedUrl, pricePath };
}

export interface QuoteUnitStatus extends PriceFeedUnit {
  price?: string;
  updatedAt?: number;
  fresh: boolean;
  error?: string;
}

export interface PriceFeedQuotes extends QuoteProvider {
  refresh(): Promise<void>;
  /** Replace the unit list. A unit whose feed changed loses its cached price. */
  setUnits(units: PriceFeedUnit[]): void;
  snapshot(): QuoteUnitStatus[];
  status(): { ok: boolean; detail: string };
}

const sameFeed = (a: PriceFeedUnit | undefined, b: PriceFeedUnit) => a?.feedUrl === b.feedUrl && a.pricePath === b.pricePath;

/** A QuoteProvider over periodically refreshed feeds. Quoting stays synchronous and
 *  never waits on a feed; a unit whose price is older than `staleAfterMs` is neither
 *  advertised nor quoted. Admin-entered units fetch through `guardedFetch`. */
export function priceFeedQuotes(cfg: {
  units: PriceFeedUnit[];
  staleAfterMs: number;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  guardedFetch?: typeof globalThis.fetch;
  now?: () => number;
  logger?: Logger;
}): PriceFeedQuotes {
  const now = cfg.now ?? Date.now;
  let units = cfg.units;
  const latest = new Map<string, { price: Price; at: number }>();
  const failures = new Map<string, string>();
  const fresh = (code: string): Price | undefined => {
    const hit = latest.get(code);
    return hit && now() - hit.at < cfg.staleAfterMs ? hit.price : undefined;
  };
  const current = (code: string) => units.find((u) => u.code === code);

  return {
    units() {
      return units.filter((u) => fresh(u.code)).map((u): Unit => ({ code: u.code, decimals: u.decimals }));
    },
    quote(req): PaymentQuote {
      if (req.receiveUnit !== undefined && req.receiveUnit !== "msat") throw new QuoteError("Unsupported receiveUnit");
      let msat: bigint;
      if (req.unit === undefined) msat = BigInt(req.amount);
      else {
        const unit = current(req.unit);
        if (!unit) throw new QuoteError("Unsupported unit");
        const price = fresh(unit.code);
        if (!price) throw new QuoteError(`${unit.code} rate is unavailable right now`);
        // Up to a whole sat: the offline-swap corridor and SDK wallets deal only in whole sats.
        msat = (unitToMsat(BigInt(req.amount), price, unit.decimals) + 999n) / 1000n * 1000n;
      }
      return {
        requested: { amount: String(req.amount), unit: req.unit ?? "msat" },
        payment: { amount: String(msat), unit: "msat" },
        receive: { amount: String(msat), unit: "msat" },
      };
    },
    async refresh() {
      await Promise.all(units.map(async (unit) => {
        const fetcher = unit.source === "admin" ? cfg.guardedFetch : cfg.fetch;
        try {
          const price = await fetchPrice(unit, { timeoutMs: cfg.timeoutMs ?? 10_000, ...(fetcher ? { fetch: fetcher } : {}) });
          // setUnits may have repointed this code while the fetch was in flight.
          if (!sameFeed(current(unit.code), unit)) return;
          latest.set(unit.code, { price, at: now() });
          failures.delete(unit.code);
        } catch (error) {
          if (!sameFeed(current(unit.code), unit)) return;
          const reason = error instanceof Error ? error.message : String(error);
          failures.set(unit.code, reason);
          cfg.logger?.warn("price_feed_failed", { unit: unit.code, reason });
        }
      }));
    },
    setUnits(next) {
      for (const unit of units) {
        if (sameFeed(next.find((u) => u.code === unit.code), unit)) continue;
        latest.delete(unit.code);
        failures.delete(unit.code);
      }
      units = next;
    },
    snapshot() {
      return units.map((u): QuoteUnitStatus => {
        const hit = latest.get(u.code);
        const error = failures.get(u.code);
        return { ...u, fresh: Boolean(fresh(u.code)), ...(hit ? { price: formatPrice(hit.price), updatedAt: hit.at } : {}), ...(error ? { error } : {}) };
      });
    },
    status() {
      const stale = units.filter((u) => !fresh(u.code));
      if (stale.length === 0) return { ok: true, detail: units.map((u) => u.code).join(", ") || "no units configured" };
      return { ok: false, detail: stale.map((u) => `${u.code}: ${failures.get(u.code) ?? "no fresh price"}`).join("; ") };
    },
  };
}
