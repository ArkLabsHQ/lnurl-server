import { describe, expect, it } from "vitest";
import request from "supertest";
import type { Logger } from "../src/logger.js";
import { openDb } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories } from "../src/db/repositories/index.js";
import { createServer } from "../src/server.js";
import { SessionManager } from "../src/services/sessions.js";

const logger: Logger = { info() {}, warn() {}, error() {} };

describe("error responses from real routes", () => {
  it("keeps the stack off the wire when a real route throws", async () => {
    const db = openDb(":memory:"); runMigrations(db); const repos = createRepositories(db);
    repos.domains.create({ domain: "domain.com", allocationModes: ["self", "random"] });
    const addressService = { register: () => { throw new Error("SQLITE_CONSTRAINT at /srv/app/data.db"); } };
    const app = createServer({ port: 0, baseUrl: "http://localhost", minSendable: 1_000, maxSendable: 1_000_000 }, { repos, addressService, logger } as never);
    const res = await request(app).post("/lnurl/address").set("Host", "domain.com").send({ token: "ab".repeat(32) });
    expect(res.status).toBe(500);
    expect(res.text).not.toMatch(/SQLITE|\.ts:\d+/);
  });

  it("tells the payer why the wallet gave no invoice, but not why anything else failed", async () => {
    const sessions = new SessionManager();
    sessions.isActive = () => true;
    const app = createServer({ port: 0, baseUrl: "http://localhost", minSendable: 1_000, maxSendable: 1_000_000 }, { sessions, logger } as never);

    sessions.requestInvoice = async () => { throw new Error("SQLITE_BUSY at /srv/app/data.db"); };
    const hidden = await request(app).get("/lnurl/abc/callback?amount=5000");
    expect(hidden.body).toEqual({ status: "ERROR", reason: "Failed to get invoice" });

    sessions.requestInvoice = () => new SessionManager().requestInvoice("missing", 5_000, undefined, 1_000);
    const shown = await request(app).get("/lnurl/abc/callback?amount=5000");
    expect(shown.body).toEqual({ status: "ERROR", reason: "Session not found" });
  });
});
