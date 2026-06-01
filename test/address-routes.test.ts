import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { createServer } from "../src/server.js";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { AddressService } from "../src/address-service.js";
import { RateLimiter } from "../src/rate-limit.js";
import type { LnurlServiceConfig } from "../src/types.js";

const KEY = randomBytes(32);
const CONFIG: LnurlServiceConfig = { port: 0, baseUrl: "", minSendable: 1000, maxSendable: 100_000_000, invoiceTimeoutMs: 3000 };
let db: Db; let repos: Repositories; let domainId: number; let ctx: { baseUrl: string; close: () => Promise<void> };

function start() {
  const server = http.createServer();
  const svc = new AddressService(repos, KEY);
  return new Promise<typeof ctx>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.on("request", createServer({ ...CONFIG, baseUrl: `http://127.0.0.1:${port}` }, { repos, addressService: svc, registrationLimiter: new RateLimiter(100, 60_000) }));
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) });
    });
  });
}
function req(method: string, url: string, opts: { host?: string; body?: unknown; bearer?: string; apiKey?: string } = {}) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.host) headers.Host = opts.host;
    if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
    if (opts.apiKey) headers["X-API-Key"] = opts.apiKey;
    const r = http.request(url, { method, headers }, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: d ? JSON.parse(d) : {} })); });
    r.on("error", reject); if (opts.body) r.write(JSON.stringify(opts.body)); r.end();
  });
}

const TOKEN = "ab".repeat(32);
beforeEach(async () => {
  db = openDb(":memory:"); runMigrations(db); repos = createRepositories(db);
  domainId = repos.domains.create({ domain: "domain.com", allocationModes: ["self", "random"] }).id;
  ctx = await start();
});
afterEach(async () => { await ctx.close(); db.close(); });

describe("address routes", () => {
  it("POST self-registers and returns lnurl", async () => {
    const res = await req("POST", `${ctx.baseUrl}/lnurl/address`, { host: "domain.com", body: { username: "devious", token: TOKEN } });
    expect(res.status).toBe(201);
    expect(res.body.lightningAddress).toBe("devious@domain.com");
    expect(String(res.body.lnurl)).toMatch(/^LNURL1/);
  });

  it("POST random-allocates without username", async () => {
    const res = await req("POST", `${ctx.baseUrl}/lnurl/address`, { host: "domain.com", body: { token: TOKEN } });
    expect(res.status).toBe(201);
    expect(String(res.body.lightningAddress)).toMatch(/@domain\.com$/);
  });

  it("POST maps a taken username to 409", async () => {
    await req("POST", `${ctx.baseUrl}/lnurl/address`, { host: "domain.com", body: { username: "dup", token: TOKEN } });
    const res = await req("POST", `${ctx.baseUrl}/lnurl/address`, { host: "domain.com", body: { username: "dup", token: "cd".repeat(32) } });
    expect(res.status).toBe(409);
  });

  it("GET lists addresses owned by the token", async () => {
    await req("POST", `${ctx.baseUrl}/lnurl/address`, { host: "domain.com", body: { username: "mine", token: TOKEN } });
    const res = await req("GET", `${ctx.baseUrl}/lnurl/address`, { bearer: TOKEN });
    expect(res.status).toBe(200);
    expect((res.body as unknown as unknown[]).length).toBe(1);
  });

  it("DELETE revokes the owner's address", async () => {
    await req("POST", `${ctx.baseUrl}/lnurl/address`, { host: "domain.com", body: { username: "gone", token: TOKEN } });
    const res = await req("DELETE", `${ctx.baseUrl}/lnurl/address/gone`, { host: "domain.com", bearer: TOKEN });
    expect(res.status).toBe(200);
    expect(repos.addresses.getByDomainAndUsername(domainId, "gone")!.status).toBe("revoked");
  });

  it("enforces the API-key gate when the domain requires it", async () => {
    repos.domains.update(domainId, { requireApiKey: true });
    const denied = await req("POST", `${ctx.baseUrl}/lnurl/address`, { host: "domain.com", body: { username: "x", token: TOKEN } });
    expect(denied.status).toBe(401);
    const { raw } = repos.apiKeys.create({ label: "ci" });
    const ok = await req("POST", `${ctx.baseUrl}/lnurl/address`, { host: "domain.com", apiKey: raw, body: { username: "x", token: TOKEN } });
    expect(ok.status).toBe(201);
  });
});
