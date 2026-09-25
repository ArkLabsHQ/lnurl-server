import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { createServer } from "../src/http/server.js";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { AddressService } from "../src/services/addresses.js";
import { RateLimiter } from "../src/rate-limit.js";
import type { LnurlServiceConfig } from "../src/types/index.js";

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
  repos.domains.create({ domain: "session.com", allocationModes: ["self", "random", "session"] });
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

  it("rate limit triggers 429 on the second request within the window", async () => {
    // Start a fresh server constrained to 1 request per window
    const limitedServer = http.createServer();
    const limitedCtx = await new Promise<typeof ctx>((resolve) => {
      limitedServer.listen(0, "127.0.0.1", () => {
        const { port } = limitedServer.address() as { port: number };
        const svc = new AddressService(repos, KEY);
        limitedServer.on(
          "request",
          createServer(
            { ...CONFIG, baseUrl: `http://127.0.0.1:${port}` },
            { repos, addressService: svc, registrationLimiter: new RateLimiter(1, 60_000) },
          ),
        );
        resolve({
          baseUrl: `http://127.0.0.1:${port}`,
          close: () => new Promise<void>((r) => { limitedServer.closeAllConnections(); limitedServer.close(() => r()); }),
        });
      });
    });
    try {
      const first = await req("POST", `${limitedCtx.baseUrl}/lnurl/address`, { host: "domain.com", body: { username: "rla", token: TOKEN } });
      expect(first.status).toBe(201);
      const second = await req("POST", `${limitedCtx.baseUrl}/lnurl/address`, { host: "domain.com", body: { username: "rlb", token: "cd".repeat(32) } });
      expect(second.status).toBe(429);
    } finally {
      await limitedCtx.close();
    }
  });

  it("POST missing token returns 400", async () => {
    const res = await req("POST", `${ctx.baseUrl}/lnurl/address`, { host: "domain.com", body: { username: "notoken" } });
    expect(res.status).toBe(400);
  });

  it("POST to unknown domain returns 404", async () => {
    const res = await req("POST", `${ctx.baseUrl}/lnurl/address`, { host: "unknown.example", body: { username: "x", token: TOKEN } });
    expect(res.status).toBe(404);
  });

  it("DELETE with wrong token returns 404", async () => {
    await req("POST", `${ctx.baseUrl}/lnurl/address`, { host: "domain.com", body: { username: "wrongtoken", token: TOKEN } });
    const res = await req("DELETE", `${ctx.baseUrl}/lnurl/address/wrongtoken`, { host: "domain.com", bearer: "ff".repeat(32) });
    expect(res.status).toBe(404);
  });
});

describe("nameless registration", () => {
  it("POST nameless: true creates then returns the same row idempotently", async () => {
    const first = await req("POST", `${ctx.baseUrl}/lnurl/address`, { host: "session.com", body: { token: TOKEN, nameless: true } });
    expect(first.status).toBe(201);
    expect(first.body.lightningAddress).toBeNull();
    expect(first.body.username).toBeNull();
    expect(typeof first.body.handle).toBe("string");
    expect(String(first.body.lnurl)).toMatch(/^LNURL1/);

    const second = await req("POST", `${ctx.baseUrl}/lnurl/address`, { host: "session.com", body: { token: TOKEN, nameless: true } });
    expect(second.status).toBe(200);
    expect(second.body.handle).toBe(first.body.handle);
  });

  it("403s without the session mode", async () => {
    const res = await req("POST", `${ctx.baseUrl}/lnurl/address`, { host: "domain.com", body: { token: TOKEN, nameless: true } });
    expect(res.status).toBe(403);
  });

  it("400s when nameless is combined with username or claimCode", async () => {
    const withUsername = await req("POST", `${ctx.baseUrl}/lnurl/address`, { host: "session.com", body: { token: TOKEN, nameless: true, username: "bob" } });
    expect(withUsername.status).toBe(400);
    expect(withUsername.body.code).toBe("invalid_username");

    const withClaimCode = await req("POST", `${ctx.baseUrl}/lnurl/address`, { host: "session.com", body: { token: TOKEN, nameless: true, claimCode: "x" } });
    expect(withClaimCode.status).toBe(400);
    expect(withClaimCode.body.code).toBe("invalid_username");
  });
});

describe("PATCH /lnurl/address/:handle (upgrade)", () => {
  async function registerNameless(token: string): Promise<string> {
    const res = await req("POST", `${ctx.baseUrl}/lnurl/address`, { host: "session.com", body: { token, nameless: true } });
    return String(res.body.handle);
  }

  it("upgrades a nameless row, and the new name resolves at .well-known", async () => {
    const handle = await registerNameless(TOKEN);
    const res = await req("PATCH", `${ctx.baseUrl}/lnurl/address/${handle}`, { host: "session.com", bearer: TOKEN, body: { username: "upgraded" } });
    expect(res.status).toBe(200);
    expect(res.body.lightningAddress).toBe("upgraded@session.com");
    expect(res.body.handle).toBe("upgraded");

    const resolved = await req("GET", `${ctx.baseUrl}/.well-known/lnurlp/upgraded`, { host: "session.com" });
    expect(resolved.status).toBe(200);
    expect(resolved.body.tag).toBe("payRequest");
  });

  it("409s already_named on a second upgrade attempt", async () => {
    const handle = await registerNameless(TOKEN);
    await req("PATCH", `${ctx.baseUrl}/lnurl/address/${handle}`, { host: "session.com", bearer: TOKEN, body: { username: "onceonly" } });
    const res = await req("PATCH", `${ctx.baseUrl}/lnurl/address/onceonly`, { host: "session.com", bearer: TOKEN, body: { username: "again" } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("already_named");
  });

  it("404s with the wrong token", async () => {
    const handle = await registerNameless(TOKEN);
    const res = await req("PATCH", `${ctx.baseUrl}/lnurl/address/${handle}`, { host: "session.com", bearer: "ff".repeat(32), body: { username: "stolen" } });
    expect(res.status).toBe(404);
  });
});

describe("re-claiming after a failed identity bind", () => {
  const OTHER = "cd".repeat(32);
  const IDENTITY = { arkadeAddress: "tark1qpf3lesxsy69q0f8yvfnyf7gv7kglfkg83fhaxjyc0zmm0wtrl3n024rshrsa8fnnv73w38094qfl9jp5g7pzdc8j2m58metfpd8rcd37nqs45", claimPublicKey: "02" + "ab".repeat(32) };

  it("returns the half-bound row to the session that made it, and the bind then lands", async () => {
    const first = await req("POST", `${ctx.baseUrl}/lnurl/address`, { host: "domain.com", body: { username: "retry", token: TOKEN } });
    expect(first.status).toBe(201);
    // The client's second call never happened: registered, no arkade identity.
    expect(repos.addresses.getByDomainAndUsername(domainId, "retry")!.arkadeAddress).toBeNull();

    const again = await req("POST", `${ctx.baseUrl}/lnurl/address`, { host: "domain.com", body: { username: "retry", token: TOKEN } });
    expect(again.status).toBe(200);
    expect(again.body.lightningAddress).toBe("retry@domain.com");
    expect(repos.addresses.list({ domainId }).filter((a) => a.username === "retry")).toHaveLength(1);

    const bind = await req("POST", `${ctx.baseUrl}/lnurl/address/retry/arkade`, { host: "domain.com", bearer: TOKEN, body: IDENTITY });
    expect(bind.status).toBe(200);
    expect(repos.addresses.getByDomainAndUsername(domainId, "retry")!.arkadeAddress).toBe(IDENTITY.arkadeAddress);
  });

  it("is idempotent for the owner after the identity is bound", async () => {
    await req("POST", `${ctx.baseUrl}/lnurl/address`, { host: "domain.com", body: { username: "bound", token: TOKEN } });
    await req("POST", `${ctx.baseUrl}/lnurl/address/bound/arkade`, { host: "domain.com", bearer: TOKEN, body: IDENTITY });
    const again = await req("POST", `${ctx.baseUrl}/lnurl/address`, { host: "domain.com", body: { username: "bound", token: TOKEN } });
    expect(again.status).toBe(200);
    expect(repos.addresses.getByDomainAndUsername(domainId, "bound")!.arkadeAddress).toBe(IDENTITY.arkadeAddress);
  });

  it("still 409s a different session, which cannot take over or rebind the row", async () => {
    await req("POST", `${ctx.baseUrl}/lnurl/address`, { host: "domain.com", body: { username: "mine", token: TOKEN } });
    const owner = repos.addresses.getByDomainAndUsername(domainId, "mine")!;

    const res = await req("POST", `${ctx.baseUrl}/lnurl/address`, { host: "domain.com", body: { username: "mine", token: OTHER } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("taken");
    expect(res.body.lnurl).toBeUndefined();

    const after = repos.addresses.getByDomainAndUsername(domainId, "mine")!;
    expect(after.sessionId).toBe(owner.sessionId);
    expect((await req("POST", `${ctx.baseUrl}/lnurl/address/mine/arkade`, { host: "domain.com", bearer: OTHER, body: IDENTITY })).status).toBe(404);
    expect(repos.addresses.getByDomainAndUsername(domainId, "mine")!.arkadeAddress).toBeNull();
  });

  it("random allocation retries with a fresh name rather than colliding", async () => {
    const first = await req("POST", `${ctx.baseUrl}/lnurl/address`, { host: "domain.com", body: { token: TOKEN } });
    const again = await req("POST", `${ctx.baseUrl}/lnurl/address`, { host: "domain.com", body: { token: TOKEN } });
    expect(again.status).toBe(201);
    expect(again.body.lightningAddress).not.toBe(first.body.lightningAddress);
  });
});

describe("owner routes by the session id of an upgraded row", () => {
  const OTHER = "cd".repeat(32);
  const IDENTITY = { arkadeAddress: "tark1qpf3lesxsy69q0f8yvfnyf7gv7kglfkg83fhaxjyc0zmm0wtrl3n024rshrsa8fnnv73w38094qfl9jp5g7pzdc8j2m58metfpd8rcd37nqs45", claimPublicKey: "02" + "ab".repeat(32) };

  async function upgraded(token: string, username: string): Promise<string> {
    const reg = await req("POST", `${ctx.baseUrl}/lnurl/address`, { host: "session.com", body: { token, nameless: true } });
    const sid = String(reg.body.handle);
    const up = await req("PATCH", `${ctx.baseUrl}/lnurl/address/${sid}`, { host: "session.com", bearer: token, body: { username } });
    expect(up.status).toBe(200);
    return sid;
  }

  it("serves payments, arkade and DELETE to the owner", async () => {
    const sid = await upgraded(TOKEN, "renamed");
    const payments = await req("GET", `${ctx.baseUrl}/lnurl/address/${sid}/payments`, { host: "session.com", bearer: TOKEN });
    expect(payments.status).toBe(200);
    expect((payments.body.source as { handle: string }).handle).toBe("renamed");

    const arkade = await req("POST", `${ctx.baseUrl}/lnurl/address/${sid}/arkade`, { host: "session.com", bearer: TOKEN, body: IDENTITY });
    expect(arkade.status).toBe(200);
    const sessionDomainId = repos.domains.getByDomain("session.com")!.id;
    expect(repos.addresses.getByDomainAndUsername(sessionDomainId, "renamed")!.claimPublicKey).toBe(IDENTITY.claimPublicKey);

    const gone = await req("DELETE", `${ctx.baseUrl}/lnurl/address/${sid}`, { host: "session.com", bearer: TOKEN });
    expect(gone.status).toBe(200);
    expect(repos.addresses.getByDomainAndUsername(sessionDomainId, "renamed")!.status).toBe("revoked");
  });

  it("409s already_named on PATCH by the old session id", async () => {
    const sid = await upgraded(TOKEN, "firstname");
    const res = await req("PATCH", `${ctx.baseUrl}/lnurl/address/${sid}`, { host: "session.com", bearer: TOKEN, body: { username: "second" } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("already_named");
  });

  it("404s a different token presenting someone's session id", async () => {
    const sid = await upgraded(TOKEN, "victim");
    expect((await req("GET", `${ctx.baseUrl}/lnurl/address/${sid}/payments`, { host: "session.com", bearer: OTHER })).status).toBe(404);
    expect((await req("POST", `${ctx.baseUrl}/lnurl/address/${sid}/arkade`, { host: "session.com", bearer: OTHER, body: IDENTITY })).status).toBe(404);
    expect((await req("DELETE", `${ctx.baseUrl}/lnurl/address/${sid}`, { host: "session.com", bearer: OTHER })).status).toBe(404);
    expect((await req("PATCH", `${ctx.baseUrl}/lnurl/address/${sid}`, { host: "session.com", bearer: OTHER, body: { username: "x" } })).status).toBe(404);
  });

  it("does not alias a named row that never had a session LNURL", async () => {
    await req("POST", `${ctx.baseUrl}/lnurl/address`, { host: "session.com", body: { token: TOKEN, username: "plain" } });
    const sid = String(repos.addresses.getByDomainAndUsername(repos.domains.getByDomain("session.com")!.id, "plain")!.sessionId);
    expect((await req("GET", `${ctx.baseUrl}/lnurl/address/${sid}/payments`, { host: "session.com", bearer: TOKEN })).status).toBe(404);
    expect((await req("DELETE", `${ctx.baseUrl}/lnurl/address/${sid}`, { host: "session.com", bearer: TOKEN })).status).toBe(404);
  });
});

describe("GET /lnurl/domain", () => {
  it("returns the domain's allocation policy", async () => {
    const res = await req("GET", `${ctx.baseUrl}/lnurl/domain`, { host: "session.com" });
    expect(res.status).toBe(200);
    expect(res.body.domain).toBe("session.com");
    expect(res.body.allocationModes).toEqual(["self", "random", "session"]);
    expect(res.body.usernameRules).toMatchObject({ minLen: expect.any(Number), maxLen: expect.any(Number), pattern: expect.any(String) });
    expect(res.body.requireApiKey).toBe(false);
  });

  it("404s for an unknown domain", async () => {
    const res = await req("GET", `${ctx.baseUrl}/lnurl/domain`, { host: "unknown.example" });
    expect(res.status).toBe(404);
  });
});

describe("GET /lnurl/address — nameless listing fields", () => {
  it("shows nameless fields, then named fields with the same sessionLnurl after upgrade", async () => {
    const registerRes = await req("POST", `${ctx.baseUrl}/lnurl/address`, { host: "session.com", body: { token: TOKEN, nameless: true } });
    const handle = String(registerRes.body.handle);

    const before = await req("GET", `${ctx.baseUrl}/lnurl/address`, { bearer: TOKEN });
    expect(before.status).toBe(200);
    const beforeEntry = (before.body as unknown as Record<string, unknown>[])[0];
    expect(beforeEntry.nameless).toBe(true);
    expect(beforeEntry.lightningAddress).toBeNull();
    expect(typeof beforeEntry.sessionLnurl).toBe("string");
    expect(String(beforeEntry.sessionLnurl)).toMatch(/^LNURL1/);

    await req("PATCH", `${ctx.baseUrl}/lnurl/address/${handle}`, { host: "session.com", bearer: TOKEN, body: { username: "named" } });

    const after = await req("GET", `${ctx.baseUrl}/lnurl/address`, { bearer: TOKEN });
    const afterEntry = (after.body as unknown as Record<string, unknown>[])[0];
    expect(afterEntry.nameless).toBe(false);
    expect(afterEntry.lightningAddress).toBe("named@session.com");
    expect(afterEntry.sessionLnurl).toBe(beforeEntry.sessionLnurl);
  });
});
