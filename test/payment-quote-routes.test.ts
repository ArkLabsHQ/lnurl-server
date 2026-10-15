import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { createServer, type ServerDeps } from "../src/http/server.js";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import type { QuoteProvider, PaymentQuote } from "../src/quote-provider.js";
import { QuoteError } from "../src/errors.js";
import { priceFeedQuotes } from "../src/price-feed.js";
import { DbSettlementStore } from "../src/settlement-store.js";
import { OfflineSwapStore } from "../src/offline-swap-store.js";
import type { OfflineSwapCreator, OfflineSwapParams } from "../src/services/offline-swaps.js";
import { SessionManager } from "../src/services/sessions.js";
import { deriveSessionId } from "../src/session-token.js";
import { buildInvoice } from "./helpers/bolt11.js";
import type { LnurlServiceConfig } from "../src/types/index.js";

const CONFIG: LnurlServiceConfig = { port: 0, baseUrl: "", minSendable: 1000, maxSendable: 100_000_000, invoiceTimeoutMs: 3000 };
const ARK = "ark1qexampledestination";
const CLAIMPK = "02" + "ab".repeat(32);

// Fixed-rate fake: `amount` cents -> amount*1000 msat.
const usd: QuoteProvider = {
  units: () => [{ code: "USD", decimals: 2, symbol: "$" }],
  quote: (req): PaymentQuote => {
    if (req.unit !== undefined && req.unit !== "USD") throw new QuoteError("Unsupported unit");
    if (req.receiveUnit !== undefined && req.receiveUnit !== "USD") throw new QuoteError("Unsupported unit");
    return { requested: { amount: String(req.amount), unit: "USD" }, payment: { amount: String(req.amount * 1000), unit: "msat" } };
  },
};

let lastCreate: OfflineSwapParams | undefined;
const fakeCreator: OfflineSwapCreator = {
  create: async (p) => { lastCreate = p; return { swapId: "swap-1", invoice: "lnbc1quoted", preimage: "ab".repeat(32), preimageHash: "cd".repeat(32), lockupAddress: "ark1lockup", recovery: { version: 1, solverName: "fake", solverPubkey: "11".repeat(32), relays: [], rfqId: "swap-1", lockupAddress: "ark1lockup", expectedAmount: p.amountSat, script: {} } }; },
  isSettled: async () => false,
};

function start(deps: ServerDeps) {
  const server = http.createServer();
  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.on("request", createServer({ ...CONFIG, baseUrl: `http://127.0.0.1:${port}` }, deps));
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) });
    });
  });
}
function getJson(url: string, host: string) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    http.get(url, { headers: { Host: host } }, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(JSON.parse(d))); }).on("error", reject);
  });
}

// Minimal SSE wallet session (same pattern as verify.test.ts).
function openSession(baseUrl: string, token?: string) {
  return new Promise<{ sessionId: string; token: string; response: http.IncomingMessage; abort: () => void }>((resolve, reject) => {
    const req = http.request(`${baseUrl}/lnurl/session`, { method: "POST", headers: { "Content-Type": "application/json" } });
    req.on("response", (res) => {
      let buf = "";
      const onData = (c: Buffer) => {
        buf += c.toString();
        for (const line of buf.split("\n")) {
          if (line.startsWith("data: ")) {
            const d = JSON.parse(line.slice(6));
            if (d.sessionId && d.token) {
              res.removeListener("data", onData);
              resolve({ sessionId: d.sessionId, token: d.token, response: res, abort: () => { res.destroy(); req.destroy(); } });
              return;
            }
          }
        }
      };
      res.on("data", onData); res.on("error", reject);
    });
    req.on("error", reject);
    if (token) req.write(JSON.stringify({ token }));
    req.end();
  });
}

function nextSseEvent(res: http.IncomingMessage, timeoutMs = 5000) {
  return new Promise<{ event: string; data: Record<string, unknown> }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for SSE event")), timeoutMs);
    let buf = "";
    const onData = (c: Buffer) => {
      buf += c.toString();
      let evt = "";
      for (const line of buf.split("\n")) {
        if (line.startsWith("event: ")) evt = line.slice(7).trim();
        if (line.startsWith("data: ") && evt) { clearTimeout(timer); res.removeListener("data", onData); resolve({ event: evt, data: JSON.parse(line.slice(6)) }); return; }
      }
    };
    res.on("data", onData);
  });
}

function postJson(url: string, body: unknown, token?: string) {
  return new Promise<{ status: number }>((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const req = http.request(url, { method: "POST", headers }, (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode ?? 0 })); });
    req.on("error", reject); req.write(JSON.stringify(body)); req.end();
  });
}

let db: Db; let repos: Repositories; let domainId: number;
beforeEach(() => {
  db = openDb(":memory:"); runMigrations(db); repos = createRepositories(db);
  domainId = repos.domains.create({ domain: "domain.com", allocationModes: ["self"] }).id;
  lastCreate = undefined;
});
afterEach(() => { db.close(); });

function addr(username: string) {
  const a = repos.addresses.create({ domainId, username, status: "active", sessionId: `sess-${username}` });
  repos.addresses.setOfflineReceive(a.id, ARK, CLAIMPK);
  return a;
}

describe("LUD-XX paymentQuote", () => {
  it("advertises units when a quote provider is configured", async () => {
    addr("alice");
    const ctx = await start({ repos, quoteProvider: usd, offlineSwapCreator: fakeCreator });
    try {
      const meta = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice`, "domain.com");
      expect(meta.units).toEqual([{ code: "USD", decimals: 2, symbol: "$" }]);
    } finally { await ctx.close(); }
  });

  it("quotes a USD callback to msat and echoes paymentQuote", async () => {
    addr("alice");
    const ctx = await start({ repos, quoteProvider: usd, offlineSwapCreator: fakeCreator });
    try {
      const cb = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=100&unit=USD`, "domain.com");
      // 100 cents -> 100000 msat -> 100 sat swap
      expect(lastCreate?.amountSat).toBe(100);
      expect(cb.pr).toBe("lnbc1quoted");
      expect(cb.paymentQuote).toMatchObject({
        requested: { amount: "100", unit: "USD" },
        payment: { amount: "100000", unit: "msat" },
      });
    } finally { await ctx.close(); }
  });

  it("quotes a unit on the arkade destination rail and records it", async () => {
    const settlements = new DbSettlementStore(db, 86_400_000);
    const a = addr("alice");
    const ctx = await start({ repos, quoteProvider: usd, offlineSwapCreator: fakeCreator, settlements });
    try {
      const cb = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=100&unit=USD&paymentOption=arkade`, "domain.com");
      // 100 cents -> 100,000 msat -> 100 sats, which is 0.000001 BTC in the BIP21 URI.
      expect(cb).toMatchObject({ status: "OK", paymentOption: "arkade", paymentDestination: ARK, paymentQuote: { requested: { amount: "100", unit: "USD" } } });
      expect(String(cb.paymentURI)).toContain("amount=0.000001");
      expect(settlements.listByAddress(a.id, 10).map((r) => [r.amountMsat, r.quote])).toEqual([[100_000, { amount: "100", unit: "USD", decimals: 2 }]]);
    } finally { await ctx.close(); }
  });

  it("rejects a non-positive amount before any provider call", async () => {
    let calls = 0;
    const counting: QuoteProvider = { units: usd.units, quote: (r) => { calls++; return usd.quote(r); } };
    addr("alice");
    const ctx = await start({ repos, quoteProvider: counting, offlineSwapCreator: fakeCreator });
    try {
      const zero = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=0&unit=USD`, "domain.com");
      expect(zero.status).toBe("ERROR");
      const neg = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=-5&unit=USD`, "domain.com");
      expect(neg.status).toBe("ERROR");
      expect(calls).toBe(0); // every rejection happened before the provider
    } finally { await ctx.close(); }
  });

  it("ignores an array-typed unit param (never type-lies to the provider)", async () => {
    addr("alice");
    const ctx = await start({ repos, quoteProvider: usd, offlineSwapCreator: fakeCreator });
    try {
      // Express parses unit[]=USD as an array — treated as absent, plain msat flow
      const cb = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=50000&unit[]=USD`, "domain.com");
      expect(cb.pr).toBe("lnbc1quoted");
      expect(cb.paymentQuote).toBeUndefined();
    } finally { await ctx.close(); }
  });

  it("quotes a receiveUnit-only callback (no unit)", async () => {
    addr("alice");
    const ctx = await start({ repos, quoteProvider: usd, offlineSwapCreator: fakeCreator });
    try {
      const cb = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=100&receiveUnit=USD`, "domain.com");
      expect(cb.pr).toBe("lnbc1quoted");
      expect(cb.paymentQuote).toBeDefined();
    } finally { await ctx.close(); }
  });

  it("rejects a quote landing outside the sendable range after conversion", async () => {
    const tiny: QuoteProvider = { units: usd.units, quote: () => ({ requested: { amount: "1", unit: "USD" }, payment: { amount: "1", unit: "msat" } }) };
    addr("alice");
    const ctx = await start({ repos, quoteProvider: tiny, offlineSwapCreator: fakeCreator });
    try {
      const cb = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=1&unit=USD`, "domain.com");
      expect(cb.status).toBe("ERROR");
      expect(String(cb.reason)).toMatch(/between/i);
    } finally { await ctx.close(); }
  });

  it("maps a provider crash to a distinct reason (not 'Unsupported unit')", async () => {
    const buggy: QuoteProvider = {
      units: () => [{ code: "USD", decimals: 2 }],
      quote: () => { throw new TypeError("oops"); },
    };
    addr("alice");
    const ctx = await start({ repos, quoteProvider: buggy, offlineSwapCreator: fakeCreator });
    try {
      const cb = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=100&unit=USD`, "domain.com");
      expect(cb.status).toBe("ERROR");
      expect(String(cb.reason)).toBe("Quote failed");
    } finally { await ctx.close(); }
  });

  it("quotes the online relay path (live SSE session) with the quoted amount", async () => {
    const sessions = new SessionManager();
    const ctx = await start({ repos, quoteProvider: usd, sessions });
    const walletToken = "ef".repeat(32);
    const a = repos.addresses.create({ domainId, username: "alice", status: "active", sessionId: deriveSessionId(walletToken) });
    repos.addresses.setOfflineReceive(a.id, ARK, CLAIMPK);
    const session = await openSession(ctx.baseUrl, walletToken);
    try {
      const hash = "cd".repeat(32);
      const evt = nextSseEvent(session.response);
      const payer = getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=100&unit=USD`, "domain.com");
      const invoiceReq = await evt;
      expect(invoiceReq.data.amountMsat).toBe(100000); // 100 USD cents -> 100000 msat relayed to the wallet
      await postJson(`${ctx.baseUrl}/lnurl/session/${session.sessionId}/invoice`, { pr: buildInvoice(hash) }, session.token);
      const cb = await payer;
      expect(cb.pr).toContain("lnbc");
      expect(cb.paymentQuote).toMatchObject({ requested: { amount: "100", unit: "USD" }, payment: { amount: "100000", unit: "msat" } });
    } finally {
      session.abort();
      await ctx.close();
    }
  });

  it("errors on an unsupported unit", async () => {
    addr("alice");
    const ctx = await start({ repos, quoteProvider: usd, offlineSwapCreator: fakeCreator });
    try {
      const cb = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=100&unit=EUR`, "domain.com");
      expect(cb.status).toBe("ERROR");
      expect(String(cb.reason)).toMatch(/unsupported unit/i);
    } finally { await ctx.close(); }
  });

  it("errors on a unit request with no provider, and omits units", async () => {
    addr("bob");
    const ctx = await start({ repos, offlineSwapCreator: fakeCreator }); // no quoteProvider
    try {
      const meta = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/bob`, "domain.com");
      expect(meta.units).toBeUndefined();
      const cb = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/bob/callback?amount=100&unit=USD`, "domain.com");
      expect(cb.status).toBe("ERROR");
    } finally { await ctx.close(); }
  });

  it("quotes from a live price feed end to end", async () => {
    const feed = http.createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end('{"price":"65000.00"}'));
    await new Promise<void>((r) => feed.listen(0, "127.0.0.1", () => r()));
    const quotes = priceFeedQuotes({
      units: [{ code: "USD", decimals: 2, feedUrl: `http://127.0.0.1:${(feed.address() as { port: number }).port}/binance`, pricePath: "/price" }],
      staleAfterMs: 60_000,
    });
    await quotes.refresh();
    addr("alice");
    const ctx = await start({ repos, quoteProvider: quotes, offlineSwapCreator: fakeCreator });
    try {
      const meta = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice`, "domain.com");
      expect(meta.units).toEqual([{ code: "USD", decimals: 2 }]);
      const cb = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=100&unit=USD`, "domain.com");
      // $1 at $65k is 1538.46 sats: rounded up to whole sats, or the corridor refuses it.
      expect(lastCreate?.amountSat).toBe(1539);
      expect(cb.paymentQuote).toMatchObject({ payment: { amount: "1539000", unit: "msat" } });
    } finally {
      await ctx.close();
      await new Promise((r) => feed.close(r));
    }
  });

  it("advertises and quotes units on a session LNURL", async () => {
    const sessions = new SessionManager();
    const ctx = await start({ repos, quoteProvider: usd, sessions });
    const session = await openSession(ctx.baseUrl);
    try {
      const meta = await getJson(`${ctx.baseUrl}/lnurl/${session.sessionId}`, "domain.com");
      expect(meta.units).toEqual([{ code: "USD", decimals: 2, symbol: "$" }]);
      const evt = nextSseEvent(session.response);
      const payer = getJson(`${ctx.baseUrl}/lnurl/${session.sessionId}/callback?amount=100&unit=USD`, "domain.com");
      expect((await evt).data.amountMsat).toBe(100000);
      await postJson(`${ctx.baseUrl}/lnurl/session/${session.sessionId}/invoice`, { pr: buildInvoice("ef".repeat(32)) }, session.token);
      expect((await payer).paymentQuote).toMatchObject({ requested: { amount: "100", unit: "USD" }, payment: { amount: "100000", unit: "msat" } });
      const bad = await getJson(`${ctx.baseUrl}/lnurl/${session.sessionId}/callback?amount=100&unit=EUR`, "domain.com");
      expect(bad).toMatchObject({ status: "ERROR", reason: "Unsupported unit" });
    } finally {
      session.abort();
      await ctx.close();
    }
  });

  it("records the quoted unit amount on the settlement, offline swap and live session alike", async () => {
    const settlements = new DbSettlementStore(db, 86_400_000);
    const sessions = new SessionManager();
    const a = addr("alice");
    const ctx = await start({ repos, quoteProvider: usd, offlineSwapCreator: fakeCreator, offlineSwaps: new OfflineSwapStore(db, 86_400_000), settlements, sessions });
    const session = await openSession(ctx.baseUrl);
    try {
      await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=100&unit=USD`, "domain.com");
      expect(settlements.listByAddress(a.id, 10).map((r) => r.quote)).toEqual([{ amount: "100", unit: "USD", decimals: 2 }]);
      const hash = "ef".repeat(32);
      const evt = nextSseEvent(session.response);
      const payer = getJson(`${ctx.baseUrl}/lnurl/${session.sessionId}/callback?amount=250&unit=USD`, "domain.com");
      await evt;
      await postJson(`${ctx.baseUrl}/lnurl/session/${session.sessionId}/invoice`, { pr: buildInvoice(hash) }, session.token);
      await payer;
      expect(settlements.get(hash)?.quote).toEqual({ amount: "250", unit: "USD", decimals: 2 });
    } finally {
      session.abort();
      await ctx.close();
    }
  });

  it("leaves a plain msat request unchanged (no paymentQuote)", async () => {
    addr("alice");
    const ctx = await start({ repos, quoteProvider: usd, offlineSwapCreator: fakeCreator });
    try {
      const cb = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=50000`, "domain.com");
      expect(lastCreate?.amountSat).toBe(50); // 50000 msat -> 50 sat
      expect(cb.paymentQuote).toBeUndefined();
      expect(cb.pr).toBe("lnbc1quoted");
    } finally { await ctx.close(); }
  });
});
