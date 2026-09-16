import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { createServer } from "../src/server.js";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { AddressService } from "../src/address-service.js";
import { RateLimiter } from "../src/rate-limit.js";
import { DbSettlementStore } from "../src/settlement-store.js";
import type { LnurlServiceConfig } from "../src/types.js";

const KEY = randomBytes(32);
const CONFIG: LnurlServiceConfig = { port: 0, baseUrl: "", minSendable: 1000, maxSendable: 100_000_000, invoiceTimeoutMs: 3000 };
let db: Db; let repos: Repositories; let domainId: number; let ctx: { baseUrl: string; close: () => Promise<void> };
let clock = 0;
let settlements: DbSettlementStore;

function start() {
  const server = http.createServer();
  const svc = new AddressService(repos, KEY);
  return new Promise<typeof ctx>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.on("request", createServer({ ...CONFIG, baseUrl: `http://127.0.0.1:${port}` }, { repos, addressService: svc, registrationLimiter: new RateLimiter(100, 60_000), settlements }));
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) });
    });
  });
}
function req(method: string, url: string, opts: { host?: string; body?: unknown; bearer?: string; auth?: string } = {}) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.host) headers.Host = opts.host;
    if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
    if (opts.auth) headers.Authorization = opts.auth;
    const r = http.request(url, { method, headers }, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: d ? JSON.parse(d) : {} })); });
    r.on("error", reject); if (opts.body) r.write(JSON.stringify(opts.body)); r.end();
  });
}

const ALICE = "ab".repeat(32);
const BOB = "cd".repeat(32);

beforeEach(async () => {
  db = openDb(":memory:"); runMigrations(db); repos = createRepositories(db);
  domainId = repos.domains.create({ domain: "domain.com", allocationModes: ["self", "random"] }).id;
  clock = 1000;
  settlements = new DbSettlementStore(db, 86_400_000, () => clock);
  ctx = await start();
});
afterEach(async () => { await ctx.close(); db.close(); });

async function register(username: string, token: string): Promise<number> {
  const res = await req("POST", `${ctx.baseUrl}/lnurl/address`, { host: "domain.com", body: { username, token } });
  expect(res.status).toBe(201);
  return repos.addresses.getByDomainAndUsername(domainId, username)!.id;
}

function seed(hash: string, addressId: number): void {
  settlements.create({ paymentHash: hash, pr: "lnbc1", sessionId: "sess", amountMsat: 1000, addressId });
}

interface Page {
  source: { domain: string; lightningAddress: string };
  payments: { paymentHash: string; createdAt: number }[];
  nextSince: number;
}

const page = (body: Record<string, unknown>): Page => body as unknown as Page;

describe("address payments route", () => {
  it("owner sees only their own rows, oldest first, with source attribution", async () => {
    const aliceId = await register("alice", ALICE);
    const bobId = await register("bob", BOB);
    clock = 1000; seed("a-old", aliceId);
    clock = 2000; seed("a-new", aliceId);
    clock = 1500; seed("b-mid", bobId);
    const res = await req("GET", `${ctx.baseUrl}/lnurl/address/alice/payments`, { host: "domain.com", bearer: ALICE });
    expect(res.status).toBe(200);
    const body = page(res.body);
    expect(body.source).toEqual({ domain: "domain.com", lightningAddress: "alice@domain.com" });
    expect(body.payments.map((p) => p.paymentHash)).toEqual(["a-old", "a-new"]);
    expect(body.nextSince).toBe(2000);
  });

  it("a second address's token gets 404", async () => {
    await register("alice", ALICE);
    await register("bob", BOB);
    const res = await req("GET", `${ctx.baseUrl}/lnurl/address/alice/payments`, { host: "domain.com", bearer: BOB });
    expect(res.status).toBe(404);
  });

  it("absent or non-Bearer Authorization gets 401", async () => {
    await register("alice", ALICE);
    const missing = await req("GET", `${ctx.baseUrl}/lnurl/address/alice/payments`, { host: "domain.com" });
    expect(missing.status).toBe(401);
    const wrongScheme = await req("GET", `${ctx.baseUrl}/lnurl/address/alice/payments`, { host: "domain.com", auth: "Token abc" });
    expect(wrongScheme.status).toBe(401);
  });

  it("unknown domain gets 404", async () => {
    await register("alice", ALICE);
    const res = await req("GET", `${ctx.baseUrl}/lnurl/address/alice/payments?domain=unknown.test`, { bearer: ALICE });
    expect(res.status).toBe(404);
  });

  it("clamps limit to 200 instead of rejecting", async () => {
    const aliceId = await register("alice", ALICE);
    for (let i = 0; i < 210; i++) seed(`bulk-${i}`, aliceId);
    const res = await req("GET", `${ctx.baseUrl}/lnurl/address/alice/payments?limit=500`, { host: "domain.com", bearer: ALICE });
    expect(res.status).toBe(200);
    expect(page(res.body).payments.length).toBe(200);
  });

  it("non-numeric since starts from the beginning", async () => {
    const aliceId = await register("alice", ALICE);
    seed("s1", aliceId);
    const res = await req("GET", `${ctx.baseUrl}/lnurl/address/alice/payments?since=abc`, { host: "domain.com", bearer: ALICE });
    expect(res.status).toBe(200);
    expect(page(res.body).payments.map((p) => p.paymentHash)).toEqual(["s1"]);
  });

  it("empty page echoes the request cursor", async () => {
    await register("alice", ALICE);
    const res = await req("GET", `${ctx.baseUrl}/lnurl/address/alice/payments?since=9999`, { host: "domain.com", bearer: ALICE });
    expect(res.status).toBe(200);
    expect(page(res.body).payments).toEqual([]);
    expect(page(res.body).nextSince).toBe(9999);
  });

  it("walks forward with since=nextSince without skipping rows sharing a millisecond", async () => {
    const aliceId = await register("alice", ALICE);
    clock = 5000;
    seed("w-b", aliceId);
    seed("w-a", aliceId);
    clock = 6000;
    seed("w-d", aliceId);
    seed("w-c", aliceId);
    const first = await req("GET", `${ctx.baseUrl}/lnurl/address/alice/payments?limit=2`, { host: "domain.com", bearer: ALICE });
    expect(first.status).toBe(200);
    const b1 = page(first.body);
    expect(b1.payments.map((p) => p.paymentHash)).toEqual(["w-a", "w-b"]);
    expect(b1.nextSince).toBe(5000);
    const second = await req("GET", `${ctx.baseUrl}/lnurl/address/alice/payments?since=${b1.nextSince}`, { host: "domain.com", bearer: ALICE });
    expect(second.status).toBe(200);
    const b2 = page(second.body);
    expect(b2.payments.map((p) => p.paymentHash)).toEqual(["w-a", "w-b", "w-c", "w-d"]);
    expect(b2.payments.slice(0, 2).map((p) => p.paymentHash)).toEqual(b1.payments.map((p) => p.paymentHash));
    expect(b2.nextSince).toBe(6000);
  });
});