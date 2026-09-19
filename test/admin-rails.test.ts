import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { randomBytes } from "node:crypto";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { AddressService } from "../src/address-service.js";
import { SessionManager } from "../src/session-manager.js";
import { createAdminApi } from "../src/admin-api.js";
import { loadConfig } from "../src/config.js";
import { SettingsService } from "../src/settings.js";
import { DbSettlementStore } from "../src/settlement-store.js";

const ARK = "ark1qexampledestination";
const CLAIMPK = "02" + "ab".repeat(32);

let db: Db; let repos: Repositories; let app: express.Express; let domainId: number;
beforeEach(() => {
  db = openDb(":memory:"); runMigrations(db); repos = createRepositories(db);
  const sessions = new SessionManager();
  const settlements = new DbSettlementStore(db, 86_400_000);
  const svc = new AddressService(repos, randomBytes(32));
  const config = loadConfig({
    PORT: "3000",
    BASE_URL: "http://localhost:3000",
    ARK_SERVER_URL: "https://ark.invalid",
    COVCLAIMD_URL: "https://cov.invalid",
    SOLVER_REGISTRY_URLS: "https://registry.invalid",
  });
  const settings = new SettingsService(repos.settings, {
    minSendable: config.minSendable, maxSendable: config.maxSendable, invoiceTimeoutMs: config.invoiceTimeoutMs,
    baseUrl: config.baseUrl, registrationRateLimitPerMin: config.registrationRateLimitPerMin,
  });
  const discovery = {
    status: () => ({
      network: "bitcoin" as const, ready: true, generation: 1, refreshedAt: Date.now(), nextRefreshAt: null, candidateCount: 2,
      sources: [], warnings: [],
    }),
    refresh: async () => {},
  };
  app = express(); app.use(express.json());
  app.use("/admin/api", createAdminApi({ repos, addressService: svc, sessions, settings, config, settlements, discovery }));
  domainId = repos.domains.create({ domain: "domain.com", allocationModes: ["self"] }).id;
});

describe("admin rails", () => {
  it("lists server-level rail capabilities", async () => {
    const res = await request(app).get("/admin/api/rails");
    expect(res.status).toBe(200);
    const byId = new Map(res.body.rails.map((r: { id: string }) => [r.id, r]));
    expect([...byId.keys()]).toEqual(["interactive-lightning", "offline-swap", "arkade", "covenant", "onchain"]);
    expect(byId.get("interactive-lightning")).toMatchObject({ configured: true, ready: true });
    expect(byId.get("offline-swap")).toMatchObject({ configured: true, ready: true });
    expect(byId.get("arkade")).toMatchObject({ configured: true, ready: true });
    expect(byId.get("covenant")).toMatchObject({ configured: false, ready: false });
    // Needs no server config; a per-address boarding address decides it.
    expect(byId.get("onchain")).toMatchObject({ configured: true, ready: true });
  });

  it("shows effective per-address rails on the addresses list", async () => {
    const a = repos.addresses.create({ domainId, username: "alice", status: "active", sessionId: "sess-alice" });
    repos.addresses.setOfflineReceive(a.id, ARK, CLAIMPK);
    const res = await request(app).get("/admin/api/addresses");
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ username: "alice", disabledRails: [] });
    const rails = new Map(res.body[0].rails.map((r: { id: string }) => [r.id, r]));
    expect(rails.get("interactive-lightning")).toMatchObject({ enabled: true, available: true });
    expect(rails.get("arkade")).toMatchObject({ enabled: true, available: true });
  });

  // Regression: the admin views built their RailAddress without the boarding
  // address, so an address whose payRequest advertised `onchain` was reported
  // here as having none.
  it("reads the onchain rail from the address's own boarding address", async () => {
    const a = repos.addresses.create({ domainId, username: "dave", status: "active", sessionId: "sess-dave" });
    repos.addresses.setOfflineReceive(a.id, ARK, CLAIMPK);
    repos.addresses.setBoardingAddress(a.id, "bcrt1qboardingexample");
    const listed = await request(app).get("/admin/api/addresses");
    const listedRails = new Map(listed.body[0].rails.map((r: { id: string }) => [r.id, r]));
    expect(listedRails.get("onchain")).toMatchObject({ enabled: true, available: true });

    const patched = await request(app).patch(`/admin/api/addresses/${a.id}/rails`).send({ disabledRails: [] });
    const patchedRails = new Map(patched.body.rails.map((r: { id: string }) => [r.id, r]));
    expect(patchedRails.get("onchain")).toMatchObject({ enabled: true, available: true });
  });

  it("stores a per-address rail policy and returns the effective states", async () => {
    const a = repos.addresses.create({ domainId, username: "bob", status: "active", sessionId: "sess-bob" });
    repos.addresses.setOfflineReceive(a.id, ARK, CLAIMPK);
    const res = await request(app).patch(`/admin/api/addresses/${a.id}/rails`).send({ disabledRails: ["arkade"] });
    expect(res.status).toBe(200);
    expect(res.body.disabledRails).toEqual(["arkade"]);
    const rails = new Map(res.body.rails.map((r: { id: string }) => [r.id, r]));
    expect(rails.get("arkade")).toMatchObject({ enabled: false, available: false, reason: "disabled for this address" });
    expect(repos.addresses.getById(a.id)?.disabledRails).toEqual(["arkade"]);
  });

  it("rejects unknown rail ids and unknown addresses", async () => {
    const a = repos.addresses.create({ domainId, username: "carol", status: "active", sessionId: "sess-carol" });
    // "onchain" used to stand in for an unknown id; it is a real rail now.
    const bad = await request(app).patch(`/admin/api/addresses/${a.id}/rails`).send({ disabledRails: ["teleport"] });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("invalid_rails");
    const missing = await request(app).patch("/admin/api/addresses/9999/rails").send({ disabledRails: [] });
    expect(missing.status).toBe(404);
  });
});