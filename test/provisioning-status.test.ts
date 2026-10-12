import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { randomBytes } from "node:crypto";
import { openDb } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { AddressService } from "../src/services/addresses.js";
import { SessionManager } from "../src/services/sessions.js";
import { SettingsService } from "../src/services/settings.js";
import { loadConfig } from "../src/config.js";
import { RateLimiter } from "../src/rate-limit.js";
import { createServer } from "../src/http/server.js";
import { createAdminApi } from "../src/http/routes/admin/index.js";

const TOKEN = "ab".repeat(32);
const OTHER = "cd".repeat(32);
let repos: Repositories;
let admin: express.Express;
let server: express.Express;

beforeEach(() => {
  const db = openDb(":memory:"); runMigrations(db); repos = createRepositories(db);
  const addressService = new AddressService(repos, randomBytes(32));
  const config = loadConfig({ PORT: "3000", BASE_URL: "http://localhost:3000" });
  const settings = new SettingsService(repos.settings, {
    minSendable: config.minSendable, maxSendable: config.maxSendable, invoiceTimeoutMs: config.invoiceTimeoutMs,
    baseUrl: config.baseUrl, registrationRateLimitPerMin: config.registrationRateLimitPerMin,
  });
  admin = express(); admin.use(express.json());
  admin.use("/admin/api", createAdminApi({ repos, addressService, sessions: new SessionManager(), settings, config }));
  server = createServer(
    { port: 0, baseUrl: "http://localhost", minSendable: 1_000, maxSendable: 1_000_000 },
    { repos, addressService, registrationLimiter: new RateLimiter(1_000, 60_000) },
  );
  repos.domains.create({ domain: "domain.com", allocationModes: ["self", "random", "session"] });
  repos.domains.create({ domain: "random-only.com", allocationModes: ["random"] });
  repos.domains.create({ domain: "one-each.com", allocationModes: ["self"], maxPerSession: 1 });
});

const register = (host: string, body: Record<string, unknown>) =>
  request(server).post("/lnurl/address").set("Host", host).send({ token: TOKEN, ...body });

describe("provisioning failures answer the same status on every API", () => {
  it("public registration", async () => {
    await register("domain.com", { username: "alice" });
    repos.blacklist.add({ domainId: null, username: "banned" });
    await request(admin).post("/admin/api/addresses").send({ domain: "domain.com", username: "reserved" });
    await register("one-each.com", { username: "first" });

    const cases: [string, Record<string, unknown>, number, string][] = [
      ["domain.com", { username: "alice", token: OTHER }, 409, "taken"],
      ["domain.com", { username: "Not Valid!" }, 400, "invalid_username"],
      ["domain.com", { username: "banned" }, 409, "blacklisted"],
      ["domain.com", { username: "reserved", claimCode: "wrong" }, 401, "invalid_claim"],
      ["domain.com", { token: "ab".repeat(16) + "a" }, 400, "invalid_token"],
      ["random-only.com", { username: "bob" }, 403, "forbidden_mode"],
      ["one-each.com", { username: "second" }, 429, "limit_reached"],
    ];
    for (const [host, body, status, code] of cases) {
      const res = await register(host, body);
      expect([res.status, res.body.code], `${host} ${JSON.stringify(body)}`).toEqual([status, code]);
    }
  });

  it("public upgrade of a nameless receiver", async () => {
    const named = await register("domain.com", { username: "carol" });
    const nameless = await register("domain.com", { nameless: true, token: OTHER });
    const upgrade = (handle: string, token: string) =>
      request(server).patch(`/lnurl/address/${handle}`).set("Host", "domain.com").set("Authorization", `Bearer ${token}`).send({ username: "dave" });

    const alreadyNamed = await upgrade(named.body.handle, TOKEN);
    expect([alreadyNamed.status, alreadyNamed.body.code]).toEqual([409, "already_named"]);
    const notOwned = await upgrade(nameless.body.handle, TOKEN);
    expect([notOwned.status, notOwned.body.code]).toEqual([404, "not_found"]);
  });

  it("admin reservation, minting and rail policy", async () => {
    repos.blacklist.add({ domainId: null, username: "banned" });
    await request(admin).post("/admin/api/addresses").send({ domain: "domain.com", username: "erin" });

    const cases: [Record<string, unknown>, number, string][] = [
      [{ username: "erin" }, 409, "taken"],
      [{ username: "erin", mode: "mint" }, 409, "taken"],
      [{ username: "Not Valid!" }, 400, "invalid_username"],
      [{ username: "banned" }, 409, "blacklisted"],
    ];
    for (const [body, status, code] of cases) {
      const res = await request(admin).post("/admin/api/addresses").send({ domain: "domain.com", ...body });
      expect([res.status, res.body.code], JSON.stringify(body)).toEqual([status, code]);
    }

    const id = repos.addresses.getByDomainAndUsername(repos.domains.getByDomain("domain.com")!.id, "erin")!.id;
    const rails = await request(admin).patch(`/admin/api/addresses/${id}/rails`).send({ disabledRails: ["no-such-rail"] });
    expect([rails.status, rails.body.code]).toEqual([400, "invalid_rails"]);
  });

  it("admin settings validation", async () => {
    const res = await request(admin).patch("/admin/api/settings").send({ invoiceTimeoutMs: -1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/positive integer/);
  });
});
