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
import { createAdminApi } from "../src/http/routes/admin/index.js";

let repos: Repositories;
let admin: express.Express;

beforeEach(() => {
  const db = openDb(":memory:"); runMigrations(db); repos = createRepositories(db);
  const config = loadConfig({ PORT: "3000", BASE_URL: "http://localhost:3000" });
  const settings = new SettingsService(repos.settings, {
    minSendable: config.minSendable, maxSendable: config.maxSendable, invoiceTimeoutMs: config.invoiceTimeoutMs,
    baseUrl: config.baseUrl, registrationRateLimitPerMin: config.registrationRateLimitPerMin,
  });
  admin = express(); admin.use(express.json());
  admin.use("/admin/api", createAdminApi({ repos, addressService: new AddressService(repos, randomBytes(32)), sessions: new SessionManager(), settings, config }));
});

describe("admin path ids", () => {
  it("refuses an id that is not a positive integer on every :id route", async () => {
    const calls: [string, string, object?][] = [
      ["patch", "/admin/api/addresses/abc", { status: "active" }],
      ["patch", "/admin/api/addresses/1.5/rails", { disabledRails: [] }],
      ["delete", "/admin/api/addresses/-1"],
      ["patch", "/admin/api/domains/0x1", {}],
      ["delete", "/admin/api/domains/abc"],
      ["delete", "/admin/api/api-keys/abc"],
      ["delete", "/admin/api/blacklist/abc"],
      ["put", "/admin/api/solver-cards/abc", {}],
      ["patch", "/admin/api/solver-cards/abc", { enabled: true }],
      ["delete", "/admin/api/solver-cards/abc"],
    ];
    for (const [method, path, body] of calls) {
      const res = await (request(admin) as unknown as Record<string, (p: string) => request.Test>)[method](path).send(body ?? {});
      expect([res.status, res.body.error], `${method} ${path}`).toEqual([400, "id must be a positive integer"]);
    }
  });

  it("answers 404 when a status change names no address", async () => {
    const res = await request(admin).patch("/admin/api/addresses/999").send({ status: "revoked" });
    expect(res.status).toBe(404);
  });
});
