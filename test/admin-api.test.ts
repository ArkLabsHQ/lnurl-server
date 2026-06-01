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

let db: Db; let repos: Repositories; let app: express.Express;
beforeEach(() => {
  db = openDb(":memory:"); runMigrations(db); repos = createRepositories(db);
  const sessions = new SessionManager();
  const svc = new AddressService(repos, randomBytes(32));
  app = express(); app.use(express.json());
  app.use("/admin/api", createAdminApi({ repos, addressService: svc, sessions }));
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

  it("manages blacklist entries", async () => {
    const add = await request(app).post("/admin/api/blacklist").send({ username: "root" });
    expect(add.status).toBe(201);
    const list = await request(app).get("/admin/api/blacklist");
    expect(list.body.map((b: { username: string }) => b.username)).toContain("root");
    const del = await request(app).delete(`/admin/api/blacklist/${add.body.id}`);
    expect(del.status).toBe(200);
  });
});
