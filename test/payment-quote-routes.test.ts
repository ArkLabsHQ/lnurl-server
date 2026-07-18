import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { createServer, type ServerDeps } from "../src/server.js";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { QuoteError, type QuoteProvider, type PaymentQuote } from "../src/quote-provider.js";
import type { OfflineSwapCreator, OfflineSwapParams } from "../src/intent-swap.js";
import type { LnurlServiceConfig } from "../src/types.js";

const CONFIG: LnurlServiceConfig = { port: 0, baseUrl: "", minSendable: 1000, maxSendable: 100_000_000, invoiceTimeoutMs: 3000 };
const ARK = "ark1qexampledestination";
const CLAIMPK = "02" + "ab".repeat(32);

// Fixed-rate fake: `amount` cents -> amount*1000 msat.
const usd: QuoteProvider = {
  units: () => [{ code: "USD", decimals: 2, symbol: "$" }],
  quote: (req): PaymentQuote => {
    if (req.unit !== "USD") throw new QuoteError("Unsupported unit");
    return { requested: { amount: String(req.amount), unit: "USD" }, payment: { amount: String(req.amount * 1000), unit: "msat" } };
  },
};

let lastCreate: OfflineSwapParams | undefined;
const fakeCreator: OfflineSwapCreator = {
  create: async (p) => { lastCreate = p; return { swapId: "swap-1", invoice: "lnbc1quoted", preimage: "ab".repeat(32), preimageHash: "cd".repeat(32), lockupAddress: "ark1lockup" }; },
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
