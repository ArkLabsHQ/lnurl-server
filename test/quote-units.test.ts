import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import express from "express";
import request from "supertest";
import { randomBytes } from "node:crypto";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { AddressService } from "../src/services/addresses.js";
import { SessionManager } from "../src/services/sessions.js";
import { SettingsService } from "../src/services/settings.js";
import { createAdminApi } from "../src/http/routes/admin/index.js";
import { loadConfig } from "../src/config.js";
import { createQuoteUnits, type QuoteUnits } from "../src/services/quote-units.js";
import { createGuardedFetch, isPrivateHost } from "../src/guarded-fetch.js";
import type { PriceFeedUnit } from "../src/price-feed.js";

describe("guarded fetch", () => {
  it("classifies private hosts", () => {
    for (const host of ["localhost", "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "224.0.0.1", "240.0.0.1", "255.255.255.255", "::1", "[fd00::1]", "::ffff:7f00:1"]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
    for (const host of ["api.coingecko.com", "8.8.8.8", "172.32.0.1", "2606:4700::1111"]) expect(isPrivateHost(host), host).toBe(false);
  });

  it("refuses an IP literal and a name resolving to a private address", async () => {
    const guarded = createGuardedFetch({ lookup: ((_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) => cb(null, [{ address: "10.0.0.5", family: 4 }])) as never });
    await expect(guarded("http://127.0.0.1:9/x")).rejects.toThrow(/refused private host/);
    await expect(guarded("http://feed.example/x")).rejects.toThrow(/private address 10\.0\.0\.5/);
  });
});

let feed: http.Server; let feedUrl: string; let feedBody: string;
let db: Db; let repos: Repositories; let quotes: QuoteUnits;
const env: PriceFeedUnit = { code: "USD", decimals: 2, feedUrl: "", pricePath: "/usd", source: "env" };

function adminApp(q: QuoteUnits | undefined) {
  const config = loadConfig({ PORT: "3000", BASE_URL: "http://localhost:3000" });
  const settings = new SettingsService(repos.settings, {
    minSendable: config.minSendable, maxSendable: config.maxSendable, invoiceTimeoutMs: config.invoiceTimeoutMs,
    baseUrl: config.baseUrl, registrationRateLimitPerMin: config.registrationRateLimitPerMin,
  });
  const app = express(); app.use(express.json());
  app.use("/admin/api", createAdminApi({ repos, addressService: new AddressService(repos, randomBytes(32)), sessions: new SessionManager(), settings, config, ...(q ? { quotes: q } : {}) }));
  return app;
}

beforeEach(async () => {
  feedBody = '{"usd":"50000","eur":"46000.5"}';
  feed = http.createServer((req, res) => {
    if (req.url === "/dead") return void res.writeHead(502).end("bad gateway");
    res.writeHead(200, { "content-type": "application/json" }).end(feedBody);
  });
  await new Promise<void>((r) => feed.listen(0, "127.0.0.1", () => r()));
  feedUrl = `http://127.0.0.1:${(feed.address() as { port: number }).port}/price`;
  db = openDb(":memory:"); runMigrations(db); repos = createRepositories(db);
  // The local feed is loopback, which the real guard refuses; that refusal has its own test.
  quotes = createQuoteUnits({ envUnits: [{ ...env, feedUrl }], repo: repos.quoteUnits, staleAfterMs: 60_000, guardedFetch: fetch });
  await quotes.refresh();
});
afterEach(async () => {
  db.close();
  await new Promise((r) => feed.close(r));
});

describe("admin quote units", () => {
  it("adds a unit live: stored, priced, and advertised by the provider", async () => {
    const res = await request(adminApp(quotes)).put("/admin/api/quote-units/eur").send({ decimals: 2, feedUrl, pricePath: "/eur" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ code: "EUR", source: "admin", overridesEnv: false, price: "46000.5", fresh: true });
    expect(repos.quoteUnits.list().map((u) => u.code)).toEqual(["EUR"]);
    expect(quotes.provider.units().map((u) => u.code)).toEqual(["USD", "EUR"]);
  });

  it("refuses a feed that does not answer, and bad input, storing nothing", async () => {
    const app = adminApp(quotes);
    const dead = await request(app).put("/admin/api/quote-units/EUR").send({ decimals: 2, feedUrl: feedUrl.replace("/price", "/dead"), pricePath: "/eur" });
    expect(dead.status).toBe(400);
    expect(dead.body).toMatchObject({ code: "feed_unreadable", error: expect.stringMatching(/HTTP 502/) });
    const decimals = await request(app).put("/admin/api/quote-units/EUR").send({ decimals: "x", feedUrl, pricePath: "/eur" });
    expect(decimals.body).toMatchObject({ code: "invalid_quote_unit", details: ["decimals"] });
    const path = await request(app).put("/admin/api/quote-units/EUR").send({ decimals: 2, feedUrl });
    expect(path.body).toMatchObject({ code: "invalid_quote_unit", details: ["pricePath"] });
    expect(repos.quoteUnits.list()).toEqual([]);
  });

  it("overrides an env unit, and removing the override restores it", async () => {
    const app = adminApp(quotes);
    const put = await request(app).put("/admin/api/quote-units/USD").send({ decimals: 2, feedUrl, pricePath: "/eur" });
    expect(put.body).toMatchObject({ source: "admin", overridesEnv: true, price: "46000.5" });
    const del = await request(app).delete("/admin/api/quote-units/usd");
    expect(del.status).toBe(200);
    expect(del.body).toEqual([expect.objectContaining({ code: "USD", source: "env", price: "50000" })]);
  });

  it("refuses to delete an env unit (409) or an unknown one (404)", async () => {
    const app = adminApp(quotes);
    expect((await request(app).delete("/admin/api/quote-units/USD")).status).toBe(409);
    expect((await request(app).delete("/admin/api/quote-units/GBP")).status).toBe(404);
  });

  it("previews a feed without saving it", async () => {
    const res = await request(adminApp(quotes)).post("/admin/api/quote-units/preview").send({ feedUrl, pricePath: "/eur" });
    expect(res.body).toEqual({ price: "46000.5" });
    expect(repos.quoteUnits.list()).toEqual([]);
  });

  it("re-reads every feed on refresh", async () => {
    feedBody = '{"usd":"60000"}';
    const res = await request(adminApp(quotes)).post("/admin/api/quote-units/refresh");
    expect(res.body).toEqual([expect.objectContaining({ code: "USD", price: "60000" })]);
  });

  it("refuses a loopback feed through the default guard", async () => {
    const guarded = createQuoteUnits({ envUnits: [], repo: repos.quoteUnits, staleAfterMs: 60_000 });
    const res = await request(adminApp(guarded)).put("/admin/api/quote-units/EUR").send({ decimals: 2, feedUrl, pricePath: "/eur" });
    expect(res.body).toMatchObject({ code: "feed_unreadable", error: expect.stringMatching(/refused private host 127\.0\.0\.1/) });
  });

  it("answers 503 when quotes are not wired", async () => {
    const res = await request(adminApp(undefined)).get("/admin/api/quote-units");
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("quotes_unavailable");
  });

  it("keeps admin units across a restart", async () => {
    await request(adminApp(quotes)).put("/admin/api/quote-units/EUR").send({ decimals: 2, feedUrl, pricePath: "/eur" });
    const restarted = createQuoteUnits({ envUnits: [{ ...env, feedUrl }], repo: createRepositories(db).quoteUnits, staleAfterMs: 60_000, guardedFetch: fetch });
    expect(restarted.list().map((u) => [u.code, u.source])).toEqual([["USD", "env"], ["EUR", "admin"]]);
  });
});
