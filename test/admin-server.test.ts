import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { randomBytes } from "node:crypto";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { AddressService } from "../src/address-service.js";
import { SessionManager } from "../src/session-manager.js";
import { createAdminServer } from "../src/admin-server.js";

let db: Db; let repos: Repositories;
beforeEach(() => { db = openDb(":memory:"); runMigrations(db); repos = createRepositories(db); });

describe("createAdminServer", () => {
  it("mounts the admin API under /admin/api", async () => {
    const app = createAdminServer({ repos, addressService: new AddressService(repos, randomBytes(32)), sessions: new SessionManager() });
    const res = await request(app).get("/admin/api/domains");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
