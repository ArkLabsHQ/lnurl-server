import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { defaultPricePath, priceFeedQuotes, priceFrom, resolvePrice, unitToMsat, type PriceFeedUnit } from "../src/price-feed.js";
import { applyQuote } from "../src/quote-provider.js";
import { loadConfig } from "../src/config.js";
import { ConfigError } from "../src/errors.js";

describe("price math", () => {
  it("reads plain decimals exactly and refuses anything else", () => {
    expect(priceFrom("62500.50")).toEqual({ mantissa: 6250050n, scale: 2 });
    expect(priceFrom(65000)).toEqual({ mantissa: 65000n, scale: 0 });
    for (const bad of ["1e5", "-1", "0", "0.00", "abc", null, {}]) expect(() => priceFrom(bad)).toThrow();
  });

  it("walks an RFC 6901 pointer, escapes and arrays included", () => {
    expect(resolvePrice({ "a/b": [{ "~x": "3.5" }] }, "/a~1b/0/~0x")).toEqual({ mantissa: 35n, scale: 1 });
    expect(resolvePrice("42", "")).toEqual({ mantissa: 42n, scale: 0 });
    expect(() => resolvePrice({ bitcoin: {} }, "/bitcoin/usd")).toThrow(/no key "usd"/);
  });

  it("derives the pointer for Binance and CoinGecko only", () => {
    expect(defaultPricePath("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT")).toBe("/price");
    expect(defaultPricePath("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=eur")).toBe("/bitcoin/eur");
    expect(defaultPricePath("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=eur,usd")).toBeNull();
    expect(defaultPricePath("https://example.com/btc")).toBeNull();
  });

  it("converts a unit amount to msat exactly, rounding a remainder up", () => {
    expect(unitToMsat(100n, priceFrom("50000"), 2)).toBe(2_000_000n); // $1 at $50k
    expect(unitToMsat(100n, priceFrom("65000"), 2)).toBe(1_538_462n); // 1538461.53…
    expect(unitToMsat(1_000_000n, priceFrom("100000.000001"), 6)).toBe(1_000_000n); // 999999.99999…
  });
});

function fakeFeed() {
  const feed = { status: 200, body: '{"bitcoin":{"usd":50000}}' as string, hits: 0, url: "", close: async () => {} };
  const server = http.createServer((_req, res) => {
    feed.hits++;
    res.writeHead(feed.status, { "content-type": "application/json" }).end(feed.body);
  });
  return new Promise<typeof feed>((resolve) => server.listen(0, "127.0.0.1", () => {
    feed.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/simple/price?ids=bitcoin&vs_currencies=usd`;
    feed.close = () => new Promise((r) => server.close(() => r()));
    resolve(feed);
  }));
}

describe("priceFeedQuotes", () => {
  let feed: Awaited<ReturnType<typeof fakeFeed>>;
  let clock = 0;
  let usd: PriceFeedUnit;
  beforeEach(async () => {
    feed = await fakeFeed();
    clock = 1_000;
    usd = { code: "USD", decimals: 2, feedUrl: feed.url, pricePath: "/bitcoin/usd" };
  });
  afterEach(() => feed.close());

  const make = () => priceFeedQuotes({ units: [usd], staleAfterMs: 10_000, now: () => clock });

  it("advertises nothing and quotes nothing before the first refresh", () => {
    const q = make();
    expect(q.units()).toEqual([]);
    expect(applyQuote(q, { amount: 100, unit: "USD" })).toEqual({ ok: false, reason: "USD rate is unavailable right now" });
    expect(q.status().ok).toBe(false);
  });

  it("quotes from the fetched price through applyQuote", async () => {
    const q = make();
    await q.refresh();
    expect(q.units()).toEqual([{ code: "USD", decimals: 2 }]);
    expect(q.units("arkade")).toEqual([]);
    expect(applyQuote(q, { amount: 100, unit: "USD" })).toEqual({
      ok: true,
      amountMsat: 2_000_000,
      paymentQuote: {
        requested: { amount: "100", unit: "USD" },
        payment: { amount: "2000000", unit: "msat" },
        receive: { amount: "2000000", unit: "msat" },
      },
    });
    expect(q.status()).toEqual({ ok: true, detail: "USD" });
  });

  it("keeps the last price through a failed refresh until it goes stale", async () => {
    const q = make();
    await q.refresh();
    feed.status = 503;
    clock += 5_000;
    await q.refresh();
    expect(applyQuote(q, { amount: 100, unit: "USD" })).toMatchObject({ ok: true, amountMsat: 2_000_000 });
    clock += 5_000;
    expect(q.units()).toEqual([]);
    expect(applyQuote(q, { amount: 100, unit: "USD" })).toMatchObject({ ok: false });
    expect(q.status()).toEqual({ ok: false, detail: expect.stringMatching(/^USD: price feed .* HTTP 503/) });
  });

  it("refuses an unknown unit and any receiveUnit but msat", async () => {
    const q = make();
    await q.refresh();
    expect(applyQuote(q, { amount: 100, unit: "EUR" })).toEqual({ ok: false, reason: "Unsupported unit" });
    expect(applyQuote(q, { amount: 100, unit: "USD", receiveUnit: "USD" })).toEqual({ ok: false, reason: "Unsupported receiveUnit" });
    expect(applyQuote(q, { amount: 5000, receiveUnit: "msat" })).toMatchObject({ ok: true, amountMsat: 5000 });
  });

  it("refuses a response over 1 MiB", async () => {
    feed.body = `{"pad":"${"x".repeat(1_048_576)}","bitcoin":{"usd":50000}}`;
    const q = make();
    await q.refresh();
    expect(q.status().detail).toMatch(/exceeded 1048576 bytes/);
  });

  it("treats a non-JSON answer as a failed refresh", async () => {
    feed.body = "<html>bad gateway</html>";
    const q = make();
    await q.refresh();
    expect(q.status().detail).toMatch(/not JSON/);
  });
});

describe("QUOTE_* config", () => {
  const base = { PORT: "3000", BASE_URL: "http://localhost:3000" };
  const coingecko = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd";

  it("is off without QUOTE_UNITS", () => {
    expect(loadConfig(base).quotes).toBeUndefined();
  });

  it("builds a unit per code, deriving the pointer where it can", () => {
    const cfg = loadConfig({ ...base, QUOTE_UNITS: "usd, EUR", QUOTE_USD_FEED_URL: coingecko, QUOTE_USD_DECIMALS: "2",
      QUOTE_EUR_FEED_URL: "https://feed.example/eur", QUOTE_EUR_PRICE_PATH: "/data/0/price", QUOTE_EUR_DECIMALS: "2", QUOTE_REFRESH_MS: "30000" });
    expect(cfg.quotes).toEqual({
      refreshMs: 30_000,
      units: [
        { code: "USD", decimals: 2, feedUrl: coingecko, pricePath: "/bitcoin/usd" },
        { code: "EUR", decimals: 2, feedUrl: "https://feed.example/eur", pricePath: "/data/0/price" },
      ],
    });
  });

  it.each([
    [{ QUOTE_UNITS: "USD" }, /QUOTE_USD_FEED_URL is required/],
    [{ QUOTE_UNITS: "USD", QUOTE_USD_FEED_URL: coingecko }, /QUOTE_USD_DECIMALS is required/],
    [{ QUOTE_UNITS: "USD", QUOTE_USD_FEED_URL: "https://feed.example/usd", QUOTE_USD_DECIMALS: "2" }, /QUOTE_USD_PRICE_PATH is required/],
    [{ QUOTE_UNITS: "USD", QUOTE_USD_FEED_URL: `${coingecko.replace("usd", "eur,usd")}`, QUOTE_USD_DECIMALS: "2" }, /QUOTE_USD_PRICE_PATH is required/],
    [{ QUOTE_UNITS: "USD", QUOTE_USD_FEED_URL: coingecko, QUOTE_USD_DECIMALS: "2", QUOTE_USD_PRICE_PATH: "bitcoin" }, /JSON pointer/],
    [{ QUOTE_UNITS: "USD,usd" }, /twice/],
    [{ QUOTE_UNITS: "US-D" }, /letters and digits/],
    [{ QUOTE_UNITS: "USD", QUOTE_USD_FEED_URL: "ftp://x", QUOTE_USD_DECIMALS: "2" }, /http/],
  ])("refuses %o", (env, message) => {
    expect(() => loadConfig({ ...base, ...env })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, ...env })).toThrow(message);
  });
});
