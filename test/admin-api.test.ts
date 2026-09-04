import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import type { Response } from "express";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { AddressService } from "../src/address-service.js";
import { SessionManager } from "../src/session-manager.js";
import { createAdminApi } from "../src/admin-api.js";
import { loadConfig } from "../src/config.js";
import { SettingsService } from "../src/settings.js";
import { DbSettlementStore } from "../src/settlement-store.js";

let db: Db; let repos: Repositories; let app: express.Express; let sessions: SessionManager; let settlements: DbSettlementStore;
beforeEach(() => {
  db = openDb(":memory:"); runMigrations(db); repos = createRepositories(db);
  sessions = new SessionManager();
  settlements = new DbSettlementStore(db, 86_400_000);
  const svc = new AddressService(repos, randomBytes(32));
  const config = loadConfig({ PORT: "3000", BASE_URL: "http://localhost:3000" });
  const settings = new SettingsService(repos.settings, {
    minSendable: config.minSendable, maxSendable: config.maxSendable, invoiceTimeoutMs: config.invoiceTimeoutMs,
    baseUrl: config.baseUrl, registrationRateLimitPerMin: config.registrationRateLimitPerMin,
  });
  app = express(); app.use(express.json());
  app.use("/admin/api", createAdminApi({ repos, addressService: svc, sessions, settings, config, settlements }));
});

describe("admin API", () => {
  it("creates and lists domains", async () => {
    const create = await request(app).post("/admin/api/domains").send({ domain: "domain.com", allocationModes: ["self", "random"] });
    expect(create.status).toBe(201);
    const list = await request(app).get("/admin/api/domains");
    expect(list.body).toHaveLength(1);
  });

  it("creates a reserved address and returns the claim code once", async () => {
    await request(app).post("/admin/api/domains").send({ domain: "domain.com", allocationModes: ["admin"] });
    const res = await request(app).post("/admin/api/addresses").send({ domain: "domain.com", username: "vip", mode: "reserve" });
    expect(res.status).toBe(201);
    expect(res.body.claimCode).toMatch(/^[0-9a-f]+$/);
    const list = await request(app).get("/admin/api/addresses?status=reserved");
    expect(list.body[0].username).toBe("vip");
    expect(list.body[0].online).toBe(false);
  });

  it("mints an address and returns the secret once", async () => {
    await request(app).post("/admin/api/domains").send({ domain: "domain.com", allocationModes: ["admin"] });
    const res = await request(app).post("/admin/api/addresses").send({ domain: "domain.com", username: "given", mode: "mint" });
    expect(res.body.secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("creates an API key (raw shown once) and lists without the raw", async () => {
    const created = await request(app).post("/admin/api/api-keys").send({ label: "ci" });
    expect(created.body.key).toMatch(/^[0-9a-f]{64}$/);
    const list = await request(app).get("/admin/api/api-keys");
    expect(list.body[0].key).toBeUndefined();
  });

  it("rejects PATCH /domains with invalid allocationModes", async () => {
    const create = await request(app).post("/admin/api/domains").send({ domain: "domain.com", allocationModes: ["self"] });
    const id = create.body.id;
    const res = await request(app).patch(`/admin/api/domains/${id}`).send({ allocationModes: ["bogus"] });
    expect(res.status).toBe(400);
  });

  it("manages blacklist entries", async () => {
    const add = await request(app).post("/admin/api/blacklist").send({ username: "root" });
    expect(add.status).toBe(201);
    const list = await request(app).get("/admin/api/blacklist");
    expect(list.body.map((b: { username: string }) => b.username)).toContain("root");
    const del = await request(app).delete(`/admin/api/blacklist/${add.body.id}`);
    expect(del.status).toBe(200);
  });

  it("lists live sessions joined to bound addresses, and disconnects them", async () => {
    await request(app).post("/admin/api/domains").send({ domain: "domain.com", allocationModes: ["self"] });
    const domain = repos.domains.getByDomain("domain.com")!;
    const sess = sessions.create(new PassThrough() as unknown as Response, "aa".repeat(32), "9.9.9.9")!;
    repos.addresses.create({ domainId: domain.id, username: "alice", sessionId: sess.id, status: "active" });

    const list = await request(app).get("/admin/api/sessions");
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ sessionId: sess.id, ip: "9.9.9.9", reusable: true, invoicesIssued: 0, pending: null });
    expect(list.body[0].addresses).toEqual([{ username: "alice", domain: "domain.com", status: "active" }]);
    expect(list.body[0]).not.toHaveProperty("token"); // never leaks the secret

    const dc = await request(app).post(`/admin/api/sessions/${sess.id}/disconnect`);
    expect(dc.status).toBe(200);
    expect(sessions.isActive(sess.id)).toBe(false);

    const missing = await request(app).post("/admin/api/sessions/deadbeef/disconnect");
    expect(missing.status).toBe(404);
  });

  it("serves the admin OpenAPI spec and Redoc docs page", async () => {
    const spec = await request(app).get("/admin/api/openapi.json");
    expect(spec.status).toBe(200);
    expect(spec.body.info.title).toMatch(/admin/i);
    expect(Object.keys(spec.body.paths)).toEqual(
      expect.arrayContaining(["/domains", "/addresses", "/api-keys", "/blacklist", "/sessions", "/settings", "/settlements"]),
    );

    const docs = await request(app).get("/admin/api/docs");
    expect(docs.status).toBe(200);
    expect(docs.headers["content-type"]).toMatch(/html/);
    expect(docs.text).toMatch(/redoc/i);
  });

  it("gets, overrides, validates, and resets settings", async () => {
    const got = await request(app).get("/admin/api/settings");
    expect(got.body.editable.minSendable).toMatchObject({ value: 1000, overridden: false });
    expect(got.body.readOnly.adminPort).toBe(3001);
    expect(got.body.readOnly.tokenEncryptionKey).toBe("unset"); // never leaks a value

    const patched = await request(app).patch("/admin/api/settings").send({ minSendable: 5000 });
    expect(patched.status).toBe(200);
    expect(patched.body.minSendable).toMatchObject({ value: 5000, overridden: true });

    const bad = await request(app).patch("/admin/api/settings").send({ baseUrl: "not-a-url" });
    expect(bad.status).toBe(400);

    const reset = await request(app).delete("/admin/api/settings/minSendable");
    expect(reset.status).toBe(200);
    expect(reset.body.minSendable).toMatchObject({ value: 1000, overridden: false });
  });

  it("lists settlement records without ever exposing the preimage or pr", async () => {
    settlements.create({ paymentHash: "ph1", pr: "lnbc1x", sessionId: "sess", preimage: "beef".repeat(16), swapId: "rfq-1", amountMsat: 50000 });
    settlements.create({ paymentHash: "vid2", pr: "", sessionId: "sess", paymentOption: "arkade", paymentDestination: "ark1xyz", amountMsat: 25000 });
    settlements.markSettled("ph1", "beef".repeat(16));

    const all = await request(app).get("/admin/api/settlements");
    expect(all.status).toBe(200);
    expect(all.body).toHaveLength(2);
    expect(all.body[0]).toMatchObject({ paymentHash: "vid2", paymentOption: "arkade", paymentDestination: "ark1xyz", settled: false });
    const swapRow = all.body.find((r: { swapId: string | null }) => r.swapId === "rfq-1");
    expect(swapRow).toMatchObject({ settled: true, hasPreimage: true, amountMsat: 50000 });
    expect(JSON.stringify(all.body)).not.toContain("beef".repeat(16));
    expect(JSON.stringify(all.body)).not.toContain("lnbc1x");

    const settledOnly = await request(app).get("/admin/api/settlements?settled=true");
    expect(settledOnly.body.map((r: { paymentHash: string }) => r.paymentHash)).toEqual(["ph1"]);
    const arkadeOnly = await request(app).get("/admin/api/settlements?option=arkade");
    expect(arkadeOnly.body.map((r: { paymentHash: string }) => r.paymentHash)).toEqual(["vid2"]);
  });
});
