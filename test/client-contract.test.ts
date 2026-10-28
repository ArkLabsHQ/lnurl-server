import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { bech32 } from "@scure/base";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "../src/http/server.js";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { AddressService } from "../src/services/addresses.js";
import { RateLimiter } from "../src/rate-limit.js";
import { DbSettlementStore } from "../src/settlement-store.js";
import type { LnurlServiceConfig } from "../src/types/index.js";
import {
  createLnurlClient,
  deriveSessionId,
  deriveSessionToken,
  syncPayments,
  LnurlError,
  LnurlTimeoutError,
} from "../packages/client/src/index.js";
import type {
  AddressListEntry,
  LnurlSession,
  PayRequest,
  PaymentMethod,
  PaymentSyncStore,
  RegisterArkadeIdentityRequest,
  RequestInvoiceOptions,
  StoredPayment,
} from "../packages/client/src/index.js";
import { tokenOptions } from "../packages/client/src/index.js";
import { lnurlRails } from "../packages/client/src/rail.js";
import { arkadeLnurl, type ArkadeLnurlConfig } from "../packages/client/src/wallet.js";
import { ArkAddress, SingleKey, type PaymentRail, type RouterContext } from "@arkade-os/sdk";
import type { PaymentMethod as ServerPaymentMethod } from "../src/payment-methods.js";
import type { AddressRow } from "../src/types/index.js";
import { OfflineSwapStore } from "../src/offline-swap-store.js";
import { priceFeedQuotes } from "../src/price-feed.js";
import { FfOrderStore } from "../src/ff-order-store.js";
import type { OfflineSwapCreator } from "../src/services/offline-swaps.js";
import { FfBudget, ffAuth, ffClient, ffHttpTransport } from "../src/rails/fixedfloat/client.js";
import { ffRates, ffRatesXml } from "../src/rails/fixedfloat/rates.js";
import { FIXEDFLOAT } from "../src/rails/fixedfloat/provider.js";
import { fakeFixedFloat, type FakeFf } from "./helpers/fake-fixedfloat.js";

const CONFIG: LnurlServiceConfig = { port: 0, baseUrl: "", minSendable: 1_000, maxSendable: 100_000_000, invoiceTimeoutMs: 3_000 };

// amountSat, when given, is encoded in the HRP with the `n` multiplier
// (value = amountSat * 10, so value * 100 msat == amountSat * 1000 msat
// exactly) — the client now decodes and checks it against the request.
function buildInvoice(paymentHashHex: string, amountSat?: number): string {
  const words: number[] = [];
  for (let i = 0; i < 7; i++) words.push(0);
  const desc = bech32.toWords(new TextEncoder().encode("hello"));
  words.push(13, desc.length >> 5, desc.length & 31, ...desc);
  const hw = bech32.toWords(Uint8Array.from(Buffer.from(paymentHashHex, "hex")));
  words.push(1, 52 >> 5, 52 & 31, ...hw);
  for (let i = 0; i < 104; i++) words.push(0);
  const hrp = amountSat === undefined ? "lnbc" : `lnbc${amountSat * 10}n`;
  return bech32.encode(hrp, words, 2000);
}

function startServer() {
  const server = http.createServer();
  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${port}`;
      server.on("request", createServer({ ...CONFIG, baseUrl }));
      resolve({ baseUrl, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) });
    });
  });
}

const PREIMAGE = "22".repeat(32);
const HASH = createHash("sha256").update(Buffer.from(PREIMAGE, "hex")).digest("hex");
const noop = () => undefined;

describe("client contract against the real server", () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;
  let sessions: LnurlSession[];
  beforeEach(async () => { ctx = await startServer(); sessions = []; });
  afterEach(async () => { for (const s of sessions) s.close(); await ctx.close(); });

  it("openSession lnurl resolves to a session-surface payRequest", async () => {
    const client = createLnurlClient({ baseUrl: ctx.baseUrl });
    const session = await client.openSession({}, { onInvoiceRequest: noop });
    sessions.push(session);
    const payRequest = await client.resolve(session.lnurl);
    expect(payRequest.tag).toBe("payRequest");
    expect(payRequest.source.surface).toBe("session");
  });

  it("payer requestInvoice receives the exact pr the receiver answered, with a verify URL", async () => {
    const pr = buildInvoice(HASH, 50);
    const receiver = createLnurlClient({ baseUrl: ctx.baseUrl });
    const session = await receiver.openSession({}, {
      onInvoiceRequest: (_req, respond) => { void respond.answerInvoice(pr); },
    });
    sessions.push(session);
    const payer = createLnurlClient({ baseUrl: ctx.baseUrl });
    const payRequest = await payer.resolve(session.lnurl);
    const invoice = await payer.requestInvoice(payRequest, { amountSat: 50 });
    expect(invoice.kind).toBe("bolt11");
    if (invoice.kind !== "bolt11") throw new Error("expected a bolt11 invoice");
    expect(invoice.pr).toBe(pr);
    expect(invoice.verify).toBe(`${ctx.baseUrl}/lnurl/verify/${HASH}`);
  });

  it("pollVerify is unsettled until reportSettled flips it with the preimage", async () => {
    const pr = buildInvoice(HASH, 50);
    const receiver = createLnurlClient({ baseUrl: ctx.baseUrl });
    const session = await receiver.openSession({}, {
      onInvoiceRequest: (_req, respond) => { void respond.answerInvoice(pr); },
    });
    sessions.push(session);
    const payer = createLnurlClient({ baseUrl: ctx.baseUrl });
    const payRequest = await payer.resolve(session.lnurl);
    const invoice = await payer.requestInvoice(payRequest, { amountSat: 50 });
    if (invoice.kind !== "bolt11" || !invoice.verify) throw new Error("expected a bolt11 invoice with a verify URL");
    const pending = await payer.pollVerify(invoice.verify, { timeoutMs: 500, intervalMs: 100 }).then(() => null, (e) => e);
    expect(pending).toBeInstanceOf(LnurlTimeoutError);
    expect((pending as LnurlTimeoutError).lastSnapshot).toMatchObject({ settled: false });
    await session.reportSettled(PREIMAGE);
    const settled = await payer.pollVerify(invoice.verify, { timeoutMs: 5000, intervalMs: 100 });
    expect(settled.settled).toBe(true);
    if (settled.kind !== "bolt11") throw new Error("expected a bolt11 verify status");
    expect(settled.preimage).toBe(PREIMAGE);
  });

  it("rejects an out-of-range amount with the server wording", async () => {
    const client = createLnurlClient({ baseUrl: ctx.baseUrl });
    const session = await client.openSession({}, { onInvoiceRequest: noop });
    sessions.push(session);
    const payRequest = await client.resolve(session.lnurl);
    const err = await client.requestInvoice(payRequest, { amountSat: 200_000 }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(LnurlError);
    expect((err as LnurlError).reason).toMatch(/Amount must be between .* millisats/);
  });

  // The test above never reaches the server — the client range-checks locally first.
  // Widening the payRequest past the server's own bounds is what actually exercises
  // the server's rejection, which is the parity this suite exists to check.
  it("the server's own out-of-range wording matches the client's", async () => {
    const client = createLnurlClient({ baseUrl: ctx.baseUrl });
    const session = await client.openSession({}, { onInvoiceRequest: noop });
    sessions.push(session);
    const payRequest = await client.resolve(session.lnurl);
    const wide = { ...payRequest, maxSendable: 10_000_000_000 };
    const err = await client.requestInvoice(wide, { amountSat: 200_000 }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(LnurlError);
    expect((err as LnurlError).reason).toBe(
      `Amount must be between ${payRequest.minSendable} and ${payRequest.maxSendable} millisats`,
    );
  });

  it("a token-derived session id agrees with the server derivation", async () => {
    const token = deriveSessionToken("ab".repeat(32), "example.com");
    const client = createLnurlClient({ baseUrl: ctx.baseUrl });
    const session = await client.openSession({ token }, { onInvoiceRequest: noop });
    sessions.push(session);
    expect(session.sessionId).toBe(deriveSessionId(token));
  });
});
describe("listPayments contract against a DB-backed server", () => {
  const KEY = randomBytes(32);
  const TOKEN = "ab".repeat(32);
  let db: Db;
  let repos: Repositories;
  let ctx: { baseUrl: string; close: () => Promise<void> };
  let settlements: DbSettlementStore;
  let clock = 0;

  beforeEach(async () => {
    db = openDb(":memory:");
    runMigrations(db);
    repos = createRepositories(db);
    repos.domains.create({ domain: "domain.com", allocationModes: ["self", "random", "session"] });
    clock = 1_000;
    settlements = new DbSettlementStore(db, 86_400_000, () => clock);
    const addressService = new AddressService(repos, KEY);
    const server = http.createServer();
    ctx = await new Promise<typeof ctx>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as { port: number };
        const baseUrl = `http://127.0.0.1:${port}`;
        server.on(
          "request",
          createServer(
            { ...CONFIG, baseUrl },
            { repos, addressService, registrationLimiter: new RateLimiter(100, 60_000), settlements },
          ),
        );
        resolve({ baseUrl, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) });
      });
    });
  });

  afterEach(async () => {
    await ctx.close();
    db.close();
  });

  function getCallback(url: string, host: string): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      http.get(url, { headers: { Host: host } }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(JSON.parse(d)));
      }).on("error", reject);
    });
  }

  it("owner listPayments contains a relay payment driven to the registered address", async () => {
    const owner = createLnurlClient({ baseUrl: ctx.baseUrl });
    const reg = await owner.registerAddress({ token: TOKEN, username: "alice", domain: "domain.com" });
    expect(reg.lightningAddress).toBe("alice@domain.com");
    const pr = buildInvoice(HASH);
    const session = await owner.openSession({ token: TOKEN }, {
      onInvoiceRequest: (_req, respond) => {
        void respond.answerInvoice(pr);
      },
    });
    try {
      const callback = await getCallback(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=50000`, "domain.com");
      expect(callback.pr).toBe(pr);
      const page = await owner.listPayments(TOKEN, "alice", { domain: "domain.com" });
      expect(page.source).toEqual({ domain: "domain.com", lightningAddress: "alice@domain.com", handle: "alice" });
      expect(page.payments.map((entry) => (entry.kind === "bolt11" ? entry.paymentHash : entry.verifyId))).toContain(HASH);
      const found = page.payments.find((entry) => entry.kind === "bolt11" && entry.paymentHash === HASH);
      expect(found).toMatchObject({ pr, settled: false });
    } finally {
      session.close();
    }
  });

  // syncPayments' correctness rests on the server's cursor semantics, and its
  // own tests stub listPayments entirely. This pages the real endpoint.
  it("syncPayments walks the real cursor and re-running adds nothing", async () => {
    const owner = createLnurlClient({ baseUrl: ctx.baseUrl });
    await owner.registerAddress({ token: TOKEN, username: "alice", domain: "domain.com" });
    const addressId = repos.addresses.getByDomainAndUsername(repos.domains.getByDomain("domain.com")!.id, "alice")!.id;
    for (const [at, hash] of [[1_000, "s1"], [2_000, "s2"], [3_000, "s3"], [4_000, "s4"]] as const) {
      clock = at;
      settlements.create({ paymentHash: hash, pr: "lnbc1", sessionId: "sess", amountMsat: 1_000, addressId });
    }

    const records = new Map<string, StoredPayment>();
    const watermarks = new Map<string, number>();
    const store: PaymentSyncStore = {
      upsert: async (next) => {
        for (const r of next) records.set(r.key, r);
      },
      readWatermark: async (b, a) => watermarks.get(`${b}|${a}`),
      writeWatermark: async (b, a, since) => {
        watermarks.set(`${b}|${a}`, since);
      },
    };
    const target = { baseUrl: ctx.baseUrl, token: TOKEN, handle: "alice", domain: "domain.com" };
    const client = () => owner;

    // limit 2 forces a second page, so the cursor is genuinely walked.
    const first = await syncPayments([target], { client, store, limit: 2 });
    expect(first.failures).toEqual([]);
    expect([...records.keys()].map((k) => k.split("|").pop()).sort()).toEqual(["s1", "s2", "s3", "s4"]);
    expect(watermarks.get(`${ctx.baseUrl}|alice@domain.com`)).toBe(4_000);

    // Resuming re-reads the boundary row; the key overwrite absorbs it.
    const again = await syncPayments([target], { client, store, limit: 2 });
    expect(again.failures).toEqual([]);
    expect(records.size).toBe(4);
  });

  // The cursor is creation-ordered, `settled` is not. A newer row exists by the
  // time the older one settles, which is exactly when the cursor forgets it.
  it("syncPayments converges on a row the server settles after a newer one arrived", async () => {
    const owner = createLnurlClient({ baseUrl: ctx.baseUrl });
    await owner.registerAddress({ token: TOKEN, username: "alice", domain: "domain.com" });
    const addressId = repos.addresses.getByDomainAndUsername(repos.domains.getByDomain("domain.com")!.id, "alice")!.id;
    for (const [at, hash] of [[1_000, HASH], [2_000, "s2"]] as const) {
      clock = at;
      settlements.create({ paymentHash: hash, pr: "lnbc1", sessionId: "sess", amountMsat: 1_000, addressId });
    }

    const records = new Map<string, StoredPayment>();
    const watermarks = new Map<string, number>();
    const store: PaymentSyncStore = {
      upsert: async (next) => {
        for (const r of next) records.set(r.key, r);
      },
      readWatermark: async (b, a) => watermarks.get(`${b}|${a}`),
      writeWatermark: async (b, a, since) => {
        watermarks.set(`${b}|${a}`, since);
      },
    };
    const target = { baseUrl: ctx.baseUrl, token: TOKEN, handle: "alice", domain: "domain.com" };

    const first = await syncPayments([target], { client: () => owner, store });
    expect(first.failures).toEqual([]);
    expect(records.get(`${ctx.baseUrl}|${HASH}`)?.settled).toBe(false);

    clock = 5_000;
    expect(settlements.markSettled(HASH, PREIMAGE)).toBe(true);
    const second = await syncPayments([target], { client: () => owner, store });

    expect(second.failures).toEqual([]);
    expect(records.get(`${ctx.baseUrl}|${HASH}`)).toMatchObject({ settled: true, preimage: PREIMAGE, settledAt: 5_000 });
  });

  // The stall guard was written from reading the server's cursor. This proves
  // the condition is reachable against the real one rather than imagined: the
  // page is full, nextSince is the last row's created_at, and it cannot move.
  it("stalls rather than loops when a full page shares one millisecond", async () => {
    const owner = createLnurlClient({ baseUrl: ctx.baseUrl });
    await owner.registerAddress({ token: TOKEN, username: "alice", domain: "domain.com" });
    const addressId = repos.addresses.getByDomainAndUsername(repos.domains.getByDomain("domain.com")!.id, "alice")!.id;
    clock = 7_000;
    for (const hash of ["t1", "t2", "t3"]) {
      settlements.create({ paymentHash: hash, pr: "lnbc1", sessionId: "sess", amountMsat: 1_000, addressId });
    }

    const store: PaymentSyncStore = {
      upsert: async () => {},
      readWatermark: async () => undefined,
      writeWatermark: async () => {},
    };
    const result = await syncPayments([{ baseUrl: ctx.baseUrl, token: TOKEN, handle: "alice", domain: "domain.com" }], {
      client: () => owner,
      store,
      limit: 2,
    });

    expect(result.failures).toHaveLength(1);
    expect(String((result.failures[0]?.error as LnurlError).message)).toContain("stalled");
    expect((result.failures[0]?.error as LnurlError).retryable).toBe(false);
  });

  // `/lnurl/:id` resolves the domain from the Host header only; this replays requests at the real port while keeping domain.com as the Host.
  function hostedFetch(baseUrl: string) {
    const real = new URL(baseUrl);
    return (url: string, init?: RequestInit) =>
      new Promise<Response>((res, reject) => {
        const target = new URL(url);
        const req = http.request(
          {
            hostname: real.hostname,
            port: real.port,
            path: `${target.pathname}${target.search}`,
            method: init?.method ?? "GET",
            headers: { ...(init?.headers as Record<string, string> | undefined), Host: target.host },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (c) => chunks.push(c));
            response.on("end", () =>
              res(
                new Response(Buffer.concat(chunks), {
                  status: response.statusCode ?? 500,
                  headers: { "content-type": String(response.headers["content-type"] ?? "application/json") },
                }),
              ),
            );
          },
        );
        req.on("error", reject);
        if (init?.body) req.write(init.body as string);
        req.end();
      });
  }

  it("registers nameless, resolves the session lnurl, upgrades to a name, and keeps listing the same sessionLnurl", async () => {
    const owner = createLnurlClient({ baseUrl: ctx.baseUrl, fetchImpl: hostedFetch(ctx.baseUrl) });
    const reg = await owner.registerAddress({ token: TOKEN, nameless: true, domain: "domain.com" });
    expect(reg).toMatchObject({ lightningAddress: null, username: null });
    expect(reg.handle).toMatch(/^[0-9a-f]{32}$/);

    const sessionPayRequest = await owner.resolve(reg.lnurl);
    expect(sessionPayRequest.tag).toBe("payRequest");

    const upgraded = await owner.upgradeAddress({ token: TOKEN, handle: reg.handle, username: "carol", domain: "domain.com" });
    expect(upgraded).toMatchObject({ lightningAddress: "carol@domain.com", username: "carol", handle: "carol" });

    const namedPayRequest = await owner.resolve("carol@domain.com");
    expect(namedPayRequest.tag).toBe("payRequest");

    const list = await owner.listAddresses(TOKEN);
    const row = list.find((a) => a.handle === "carol");
    expect(row?.sessionLnurl).toBe(reg.lnurl);
  });
});

// The per-rail bounds crossed the server/client boundary wrongly three times
// before this existed: unit tests on each side agreed with each other and with
// the bug. This drives the real client against the real server.
describe("per-rail bounds contract", () => {
  const KEY = randomBytes(32);
  const TOKEN = "cd".repeat(32);
  const ARK = "ark1qexampledestination";
  const CLAIMPK = "02" + "ab".repeat(32);
  let db: Db;
  let repos: Repositories;
  let ctx: { baseUrl: string; close: () => Promise<void> };

  beforeEach(async () => {
    db = openDb(":memory:");
    runMigrations(db);
    repos = createRepositories(db);
    // Registered under the loopback host so the client's own Host header
    // resolves it, which lets resolve() run for real instead of being faked.
    const domain = repos.domains.create({ domain: "127.0.0.1", allocationModes: ["self"] });
    const addressService = new AddressService(repos, KEY);
    const server = http.createServer();
    ctx = await new Promise<typeof ctx>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as { port: number };
        const baseUrl = `http://127.0.0.1:${port}`;
        server.on(
          "request",
          createServer(
            { ...CONFIG, baseUrl },
            {
              repos,
              addressService,
              registrationLimiter: new RateLimiter(100, 60_000),
              settlements: new DbSettlementStore(db, 86_400_000),
              // Lightning is pinned well above the envelope floor; arkade is not.
              railLimits: { "interactive-lightning": { minSendable: 50_000_000 } },
            },
          ),
        );
        resolve({ baseUrl, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) });
      });
    });
    const reg = repos.addresses.create({ domainId: domain.id, username: "alice", status: "active", sessionId: deriveSessionId(TOKEN) });
    // Set directly: registerArkadeIdentity decodes the address with the SDK and
    // this test is about amounts, not address encoding.
    repos.addresses.setOfflineReceive(reg.id, ARK, CLAIMPK);
  });

  afterEach(async () => {
    await ctx.close();
    db.close();
  });

  it("lets the client pay an amount the arkade rail allows but lightning does not", async () => {
    const payer = createLnurlClient();
    // An LNURL wrapping a /.well-known/lnurlp/ URL carries the address surface,
    // which is what paymentOptions live on.
    const lnurl = bech32.encode(
      "lnurl",
      bech32.toWords(new TextEncoder().encode(`${ctx.baseUrl}/.well-known/lnurlp/alice`)),
      1023,
    );
    const payRequest = await payer.resolve(lnurl);
    expect(payRequest.source.surface).toBe("address");

    // Top level is the lightning rail's, and arkade publishes the wider floor.
    expect(payRequest.minSendable).toBe(50_000_000);
    expect(payRequest.paymentOptions).toContainEqual({ id: "arkade", type: "arkade", verifiable: false, minSendable: 1_000 });

    // The server builds the callback origin from the registered domain, which
    // carries no port, so the advertised URL is port 80. Put the test port back
    // rather than register a domain the Host header could not match.
    const reachable = { ...payRequest, callback: payRequest.callback.replace("127.0.0.1", new URL(ctx.baseUrl).host) };

    // 1000 sat = 1_000_000 msat: under the lightning floor, over arkade's.
    const result = await payer.requestInvoice(reachable, { amountSat: 1_000, paymentOption: "arkade" });
    expect(result).toMatchObject({ kind: "destination", paymentOption: "arkade", paymentDestination: ARK });

    // The same amount without an option resolves to lightning and is refused
    // locally, before the wire, by the top-level pair.
    await expect(payer.requestInvoice(reachable, { amountSat: 1_000 })).rejects.toBeInstanceOf(LnurlError);
  });
});

// The payer's half of LUD-XX units against the server's quote, at a price that is not
// a whole number of sats per cent, so the whole-sat rounding is exercised too.
describe("unit quote contract", () => {
  const KEY = randomBytes(32);
  const TOKEN = "ef".repeat(32);
  const ARK = "ark1qexampledestination";
  let db: Db;
  let ctx: { baseUrl: string; close: () => Promise<void> };
  let feed: http.Server;

  beforeEach(async () => {
    feed = http.createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end('{"usd":"65000"}'));
    await new Promise<void>((r) => feed.listen(0, "127.0.0.1", () => r()));
    const quoteProvider = priceFeedQuotes({
      units: [{ code: "USD", decimals: 2, feedUrl: `http://127.0.0.1:${(feed.address() as { port: number }).port}/`, pricePath: "/usd" }],
      staleAfterMs: 60_000,
    });
    await quoteProvider.refresh();
    db = openDb(":memory:");
    runMigrations(db);
    const repos = createRepositories(db);
    const domain = repos.domains.create({ domain: "127.0.0.1", allocationModes: ["self"] });
    const reg = repos.addresses.create({ domainId: domain.id, username: "alice", status: "active", sessionId: deriveSessionId(TOKEN) });
    repos.addresses.setOfflineReceive(reg.id, ARK, "02" + "ab".repeat(32));
    const server = http.createServer();
    ctx = await new Promise<typeof ctx>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        server.on("request", createServer({ ...CONFIG, baseUrl }, {
          repos, addressService: new AddressService(repos, KEY), settlements: new DbSettlementStore(db, 86_400_000), quoteProvider,
        }));
        resolve({ baseUrl, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) });
      });
    });
  });

  afterEach(async () => {
    await ctx.close();
    await new Promise((r) => feed.close(r));
    db.close();
  });

  it("pays $5.00 to an arkade destination at the quoted whole sats, and the owner's history shows the $5.00", async () => {
    const payer = createLnurlClient();
    const lnurl = bech32.encode("lnurl", bech32.toWords(new TextEncoder().encode(`${ctx.baseUrl}/.well-known/lnurlp/alice`)), 1023);
    const payRequest = await payer.resolve(lnurl);
    expect(payRequest.units).toEqual([{ code: "USD", decimals: 2 }]);
    const reachable = { ...payRequest, callback: payRequest.callback.replace("127.0.0.1", new URL(ctx.baseUrl).host) };

    const result = await payer.requestInvoice(reachable, { unit: "USD", amount: 500, paymentOption: "arkade" });
    // 500 cents at $65,000 is 7692.3 sats: the payer is asked for 7693.
    expect(result).toMatchObject({
      kind: "destination", paymentDestination: ARK,
      paymentQuote: { requested: { amount: "500", unit: "USD" }, payment: { amount: "7693000", unit: "msat" } },
    });

    const owner = createLnurlClient({ baseUrl: ctx.baseUrl });
    const page = await owner.listPayments(TOKEN, "alice", { domain: "127.0.0.1" });
    expect(page.payments.map((p) => [p.amountMsat, p.quote])).toEqual([[7_693_000, { amount: "500", unit: "USD", decimals: 2 }]]);
  });

  it("pays a session LNURL in USD with the invoice its wallet issued for the quote", async () => {
    const wallet = createLnurlClient({ baseUrl: ctx.baseUrl });
    const asked: number[] = [];
    const session = await wallet.openSession({}, {
      onInvoiceRequest: (req, respond) => { asked.push(req.amountMsat); void respond.answerInvoice(buildInvoice(HASH, req.amountMsat / 1000)); },
    });
    try {
      const payer = createLnurlClient();
      const payRequest = await payer.resolve(session.lnurl);
      const result = await payer.requestInvoice(payRequest, { unit: "USD", amount: 100 });
      expect(asked).toEqual([1_539_000]);
      expect(result).toMatchObject({ kind: "bolt11", paymentQuote: { payment: { amount: "1539000", unit: "msat" } } });
    } finally {
      session.close();
    }
  });
});

// Both halves: the client registers the boarding address, the server advertises.
describe("onchain rail contract", () => {
  const KEY = randomBytes(32);
  const TOKEN = "ef".repeat(32);
  const ARK = "tark1qpf3lesxsy69q0f8yvfnyf7gv7kglfkg83fhaxjyc0zmm0wtrl3n024rshrsa8fnnv73w38094qfl9jp5g7pzdc8j2m58metfpd8rcd37nqs45";
  const CLAIMPK = "02" + "ab".repeat(32);
  const BOARDING = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";
  let db: Db;
  let ctx: { baseUrl: string; close: () => Promise<void> };

  beforeEach(async () => {
    db = openDb(":memory:");
    runMigrations(db);
    const repos = createRepositories(db);
    repos.domains.create({ domain: "127.0.0.1", allocationModes: ["self"] });
    const server = http.createServer();
    ctx = await new Promise<typeof ctx>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as { port: number };
        const baseUrl = `http://127.0.0.1:${port}`;
        server.on(
          "request",
          createServer(
            { ...CONFIG, baseUrl },
            {
              repos,
              addressService: new AddressService(repos, KEY),
              registrationLimiter: new RateLimiter(100, 60_000),
              settlements: new DbSettlementStore(db, 86_400_000),
            },
          ),
        );
        resolve({ baseUrl, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) });
      });
    });
  });

  afterEach(async () => {
    await ctx.close();
    db.close();
  });

  it("advertises onchain for a boarding address the client registered, and pays it without a verify URL", async () => {
    const owner = createLnurlClient({ baseUrl: ctx.baseUrl });
    await owner.registerAddress({ token: TOKEN, username: "alice" });
    await owner.registerArkadeIdentity({
      token: TOKEN, handle: "alice", arkadeAddress: ARK, claimPublicKey: CLAIMPK, boardingAddress: BOARDING,
    });

    const payer = createLnurlClient();
    const lnurl = bech32.encode(
      "lnurl",
      bech32.toWords(new TextEncoder().encode(`${ctx.baseUrl}/.well-known/lnurlp/alice`)),
      1023,
    );
    const payRequest = await payer.resolve(lnurl);
    expect(payRequest.paymentOptions).toContainEqual({ id: "onchain", type: "onchain", verifiable: false });

    const reachable = { ...payRequest, callback: payRequest.callback.replace("127.0.0.1", new URL(ctx.baseUrl).host) };
    const result = await payer.requestInvoice(reachable, { amountSat: 1_000, paymentOption: "onchain" });
    expect(result).toEqual({ kind: "destination", paymentOption: "onchain", paymentDestination: BOARDING, paymentURI: `bitcoin:${BOARDING}?amount=0.00001` });
    expect("verify" in result).toBe(false);
  });

  it("leaves a registered boarding address alone when a later call omits it", async () => {
    const owner = createLnurlClient({ baseUrl: ctx.baseUrl });
    await owner.registerAddress({ token: TOKEN, username: "bob" });
    const identity = { token: TOKEN, handle: "bob", arkadeAddress: ARK, claimPublicKey: CLAIMPK };
    await owner.registerArkadeIdentity({ ...identity, boardingAddress: BOARDING });
    await owner.registerArkadeIdentity(identity);

    const payer = createLnurlClient();
    const lnurl = bech32.encode(
      "lnurl",
      bech32.toWords(new TextEncoder().encode(`${ctx.baseUrl}/.well-known/lnurlp/bob`)),
      1023,
    );
    const payRequest = await payer.resolve(lnurl);
    expect(payRequest.paymentOptions).toContainEqual({ id: "onchain", type: "onchain", verifiable: false });
  });

  it("re-binds through the facade only an alias whose listed destination moved", async () => {
    const owner = createLnurlClient({ baseUrl: ctx.baseUrl });
    let binds = 0;
    const client = { ...owner, registerArkadeIdentity: (r: Parameters<typeof owner.registerArkadeIdentity>[0]) => (binds++, owner.registerArkadeIdentity(r)) };
    const identity = SingleKey.fromHex("22".repeat(32));
    const facade = (arkadeAddress: string) => arkadeLnurl({ identity, arkadeAddress, boardingAddress: BOARDING, baseUrl: ctx.baseUrl, client });
    const moved = new ArkAddress(new Uint8Array(32).fill(2), new Uint8Array(32).fill(3), "tark").encode();

    await facade(ARK).claim({ username: "carol" });
    await facade(ARK).owned({ refresh: true });
    expect(binds).toBe(1);

    await facade(moved).owned({ refresh: true });
    expect(binds).toBe(2);
    expect(await facade(moved).addresses()).toMatchObject([{ handle: "carol", arkadeAddress: moved, boardingAddress: BOARDING }]);
  });
});

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe("registered methods contract", () => {
  const KEY = randomBytes(32);
  const TOKEN = "ef".repeat(32);
  const ARK = "tark1qpf3lesxsy69q0f8yvfnyf7gv7kglfkg83fhaxjyc0zmm0wtrl3n024rshrsa8fnnv73w38094qfl9jp5g7pzdc8j2m58metfpd8rcd37nqs45";
  const CLAIMPK = "02" + "ab".repeat(32);
  const BOARDING = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";
  const METHOD = { type: "shielded", destination: "shrol21abc" };
  const OTHER = { type: "nostr", destination: "npub1xyz" };
  let db: Db;
  let ctx: { baseUrl: string; close: () => Promise<void> };

  beforeEach(async () => {
    db = openDb(":memory:");
    runMigrations(db);
    const repos = createRepositories(db);
    repos.domains.create({ domain: "127.0.0.1", allocationModes: ["self"] });
    const server = http.createServer();
    ctx = await new Promise<typeof ctx>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as { port: number };
        const baseUrl = `http://127.0.0.1:${port}`;
        server.on("request", createServer({ ...CONFIG, baseUrl }, {
          repos,
          addressService: new AddressService(repos, KEY),
          registrationLimiter: new RateLimiter(100, 60_000),
          settlements: new DbSettlementStore(db, 86_400_000),
        }));
        resolve({ baseUrl, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) });
      });
    });
  });

  afterEach(async () => {
    await ctx.close();
    db.close();
  });

  const payRequestOf = async (handle: string): Promise<PayRequest> => {
    const lnurl = bech32.encode("lnurl", bech32.toWords(new TextEncoder().encode(`${ctx.baseUrl}/.well-known/lnurlp/${handle}`)), 1023);
    const payRequest = await createLnurlClient().resolve(lnurl);
    return { ...payRequest, callback: payRequest.callback.replace("127.0.0.1", new URL(ctx.baseUrl).host) };
  };

  it("the client's method type matches the server's bind contract", () => {
    const method: Same<PaymentMethod, ServerPaymentMethod> = true;
    const bind: Same<RegisterArkadeIdentityRequest["methods"], ServerPaymentMethod[] | undefined> = true;
    const config: Same<ArkadeLnurlConfig["methods"], ServerPaymentMethod[] | undefined> = true;
    const listed: Same<AddressListEntry["paymentMethods"], AddressRow["paymentMethods"] | null | undefined> = true;
    expect([method, bind, config, listed]).toEqual([true, true, true, true]);
  });

  it("binds methods, lists them back, and hands a payer the destination of a registered option", async () => {
    const owner = createLnurlClient({ baseUrl: ctx.baseUrl });
    await owner.registerAddress({ token: TOKEN, username: "alice" });
    await owner.registerArkadeIdentity({ token: TOKEN, handle: "alice", arkadeAddress: ARK, claimPublicKey: CLAIMPK, methods: [METHOD, OTHER] });
    expect(await owner.listAddresses(TOKEN)).toMatchObject([{ handle: "alice", paymentMethods: [METHOD, OTHER] }]);

    const payRequest = await payRequestOf("alice");
    expect(payRequest.paymentOptions).toContainEqual({ id: "registered:shielded", type: "shielded", verifiable: false });
    expect(tokenOptions(payRequest)).toEqual([]);
    const result = await createLnurlClient().requestInvoice(payRequest, { amountSat: 1_000, paymentOption: "registered:shielded" });
    expect(result).toEqual({ kind: "destination", paymentOption: "registered:shielded", paymentDestination: METHOD.destination });
  });

  it("leaves the registered methods alone when a later bind omits them, and withdraws them with an empty list", async () => {
    const owner = createLnurlClient({ baseUrl: ctx.baseUrl });
    await owner.registerAddress({ token: TOKEN, username: "bob" });
    const bind = { token: TOKEN, handle: "bob", arkadeAddress: ARK, claimPublicKey: CLAIMPK };
    const listed = async () => (await owner.listAddresses(TOKEN))[0]?.paymentMethods;

    await owner.registerArkadeIdentity({ ...bind, methods: [METHOD] });
    await owner.registerArkadeIdentity(bind);
    expect(await listed()).toEqual([METHOD]);
    await owner.registerArkadeIdentity({ ...bind, methods: [] });
    expect(await listed()).toEqual([]);
  });

  it("lnurlRails quote the arkade option and ignore the registered one beside it", async () => {
    const owner = createLnurlClient({ baseUrl: ctx.baseUrl });
    await owner.registerAddress({ token: TOKEN, username: "carol" });
    await owner.registerArkadeIdentity({ token: TOKEN, handle: "carol", arkadeAddress: ARK, claimPublicKey: CLAIMPK, methods: [METHOD] });
    const payRequest = await payRequestOf("carol");
    expect(payRequest.paymentOptions).toContainEqual(expect.objectContaining({ id: "registered:shielded" }));
    const payer = createLnurlClient();
    const railsOver = (resolved: PayRequest) => {
      const asked: (string | undefined)[] = [];
      const client = {
        ...payer,
        resolve: async () => resolved,
        requestInvoice: (pr: PayRequest, o: RequestInvoiceOptions) => (asked.push(o.paymentOption), payer.requestInvoice(pr, o)),
      };
      const inner = (id: string) => ({
        id, match: () => true, quote: async () => ({ railId: id, amount: 1_000, fee: 0, total: 1_000, send: async () => ({}) }),
      }) as unknown as PaymentRail;
      return { asked, rails: lnurlRails({ client, arkade: inner("ark"), lightning: inner("solver-lightning") }) };
    };
    const req = { raw: "carol@127.0.0.1", amount: 1_000 };
    const ctxStub = {} as RouterContext;

    const beside = railsOver(payRequest);
    expect(beside.rails.map((r) => r.id)).toEqual(["lnurl-arkade", "lnurl-lightning"]);
    await beside.rails[0]!.quote(req, ctxStub);
    expect(beside.asked).toEqual(["arkade"]);

    const alone = railsOver({ ...payRequest, paymentOptions: payRequest.paymentOptions!.filter((o) => o.type === "shielded") });
    for (const rail of alone.rails) expect(await rail.available!(req, ctxStub)).toBe(false);
  });

  it("keeps the server's methods in step through the facade, and only when the facade supplies them", async () => {
    const owner = createLnurlClient({ baseUrl: ctx.baseUrl });
    let binds = 0;
    const client = { ...owner, registerArkadeIdentity: (r: Parameters<typeof owner.registerArkadeIdentity>[0]) => (binds++, owner.registerArkadeIdentity(r)) };
    const identity = SingleKey.fromHex("22".repeat(32));
    const facade = (methods?: PaymentMethod[]) =>
      arkadeLnurl({ identity, arkadeAddress: ARK, boardingAddress: BOARDING, baseUrl: ctx.baseUrl, client, ...(methods ? { methods } : {}) });
    const listed = async () => (await facade().addresses())[0]?.paymentMethods;

    await facade([METHOD]).claim({ username: "dave" });
    expect([binds, await listed()]).toEqual([1, [METHOD]]);

    await facade([METHOD]).owned({ refresh: true });
    expect(binds).toBe(1);

    await facade([METHOD, OTHER]).owned({ refresh: true });
    expect([binds, await listed()]).toEqual([2, [METHOD, OTHER]]);

    await facade().owned({ refresh: true });
    expect([binds, await listed()]).toEqual([2, [METHOD, OTHER]]);

    await facade([]).owned({ refresh: true });
    await facade([]).owned({ refresh: true });
    expect([binds, await listed()]).toEqual([3, []]);
  });
});

describe("token rail contract", () => {
  const ARK = "tark1qpf3lesxsy69q0f8yvfnyf7gv7kglfkg83fhaxjyc0zmm0wtrl3n024rshrsa8fnnv73w38094qfl9jp5g7pzdc8j2m58metfpd8rcd37nqs45";
  let db: Db; let ff: FakeFf; let ctx: { baseUrl: string; close: () => Promise<void> };

  beforeEach(async () => {
    db = openDb(":memory:"); runMigrations(db);
    const repos = createRepositories(db);
    const domain = repos.domains.create({ domain: "127.0.0.1", allocationModes: ["self"] });
    const reg = repos.addresses.create({ domainId: domain.id, username: "alice", status: "active", sessionId: "s-alice" });
    repos.addresses.setOfflineReceive(reg.id, ARK, "02" + "ab".repeat(32));
    ff = await fakeFixedFloat();
    const client = ffClient({ transport: ffHttpTransport({ baseUrl: ff.baseUrl, auth: ffAuth(ff.apiKey, ff.secret) }), budget: new FfBudget() });
    const rates = ffRates({ client, fetchRatesXml: ffRatesXml(ff.ratesUrl), idPrefix: "ff-", staleAfterMs: 900_000 });
    await rates.refresh();
    const corridor: OfflineSwapCreator = {
      isSettled: async () => false,
      create: async (p) => {
        const preimage = randomBytes(32).toString("hex");
        const hash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
        return { swapId: `rfq-${hash.slice(0, 8)}`, invoice: buildInvoice(hash, p.amountSat), preimage, preimageHash: hash, lockupAddress: ARK,
          invoiceExpiresAt: Math.floor(Date.now() / 1000) + 1_800,
          recovery: { version: 1, solverName: "s", solverPubkey: "11".repeat(32), relays: ["wss://relay.example"], rfqId: `rfq-${hash.slice(0, 8)}`, lockupAddress: ARK, expectedAmount: p.amountSat - 20, script: {} } };
      },
    };
    const server = http.createServer();
    ctx = await new Promise<typeof ctx>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        server.on("request", createServer({ ...CONFIG, baseUrl }, {
          repos, addressService: new AddressService(repos, randomBytes(32)), settlements: new DbSettlementStore(db, 86_400_000),
          offlineSwapCreator: corridor, offlineSwaps: new OfflineSwapStore(db, 86_400_000),
          fixedFloat: { provider: FIXEDFLOAT, rates, client, orders: new FfOrderStore(db, 86_400_000), settleMarginSeconds: 600, minPayWindowSeconds: 300, maxOpenOrders: 20, maxOpenOrdersPerAddress: 2, ordersPerIp: 2, ipWindowSeconds: 600 },
        }));
        resolve({ baseUrl, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) });
      });
    });
  });

  afterEach(async () => {
    await ctx.close();
    await ff.close();
    db.close();
  });

  it("parses asset, unit and provider off a payment option, and pays one for a quoted destination", async () => {
    const payer = createLnurlClient();
    const lnurl = bech32.encode("lnurl", bech32.toWords(new TextEncoder().encode(`${ctx.baseUrl}/.well-known/lnurlp/alice`)), 1023);
    const payRequest = await payer.resolve(lnurl);
    const [usdt] = tokenOptions(payRequest);
    expect(usdt).toMatchObject({ id: "ff-usdtarbitrum", provider: "FixedFloat", unit: { code: "USDT", decimals: 6 }, asset: { chainId: "eip155:42161" } });
    expect(tokenOptions(payRequest)).toHaveLength(13);

    const reachable = { ...payRequest, callback: payRequest.callback.replace("127.0.0.1", new URL(ctx.baseUrl).host) };
    const result = await payer.requestInvoice(reachable, { amountSat: 10_000, paymentOption: "ff-usdtarbitrum" });
    expect(result).toMatchObject({
      kind: "destination", paymentOption: "ff-usdtarbitrum", provider: "FixedFloat",
      paymentQuote: { payment: { amount: "8426000", unit: "USDT" }, requested: { amount: "10000000", unit: "msat" } },
      paymentURI: expect.stringMatching(/^ethereum:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9@42161\/transfer\?address=0x[0-9a-f]{40}&uint256=8426000$/),
    });
    expect(result).not.toHaveProperty("expiresAt");
  });
});
