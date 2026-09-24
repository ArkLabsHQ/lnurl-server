import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { BadRequest, LnurlError, NotFound, httpErrorHandler, lnurlErrorHandler } from "../src/http-responses.js";
import type { Logger } from "../src/logger.js";
import { openDb } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories } from "../src/db/repositories/index.js";
import { createServer } from "../src/server.js";

const appThrowing = (err: unknown) => {
  const app = express();
  app.get("/sync", () => { throw err; });
  app.get("/async", async () => { throw err; });
  app.use(lnurlErrorHandler);
  return app;
};

describe("lnurlErrorHandler", () => {
  it.each(["/sync", "/async"])("answers a thrown LnurlError as a LUD-06 error body (%s)", async (path) => {
    const res = await request(appThrowing(new LnurlError("Unknown LN address"))).get(path);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ERROR", reason: "Unknown LN address" });
  });

  it("keeps an explicit status", async () => {
    const res = await request(appThrowing(new LnurlError("Too many requests", 429))).get("/sync");
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ status: "ERROR", reason: "Too many requests" });
  });

  it("passes any other error on", async () => {
    const res = await request(appThrowing(new Error("boom"))).get("/sync");
    expect(res.status).toBe(500);
    expect(res.body).not.toHaveProperty("status", "ERROR");
  });
});

describe("httpErrorHandler", () => {
  const logged: unknown[] = [];
  const logger: Logger = { info() {}, warn() {}, error: (_event, fields) => { logged.push(fields?.error); } };
  const appThrowingRest = (err: unknown) => {
    const app = express();
    app.use(express.json({ limit: "1kb" }));
    app.post("/", () => { throw err; });
    app.use(httpErrorHandler(logger));
    return app;
  };

  it("answers an HttpError with its status, message and extras", async () => {
    const res = await request(appThrowingRest(new BadRequest("bad card", { code: "invalid_solver_card", details: ["x"] }))).post("/");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "bad card", code: "invalid_solver_card", details: ["x"] });
  });

  it("defaults the message where the class has one", async () => {
    const res = await request(appThrowingRest(new NotFound())).post("/");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found" });
  });

  it("answers body-parser failures as JSON with their own status", async () => {
    const malformed = await request(appThrowingRest(null)).post("/").set("Content-Type", "application/json").send("{");
    expect(malformed.status).toBe(400);
    expect(malformed.body).toHaveProperty("error");
    const oversized = await request(appThrowingRest(null)).post("/").send({ pad: "a".repeat(2_000) });
    expect(oversized.status).toBe(413);
    expect(oversized.body).toHaveProperty("error");
  });

  it("hides an unexpected error behind a generic 500 and logs it", async () => {
    const err = new Error("SQLITE_CONSTRAINT at /srv/app/data.db");
    const res = await request(appThrowingRest(err)).post("/");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    expect(logged).toContain(err);
  });

  it("keeps the stack off the wire when a real route throws", async () => {
    const db = openDb(":memory:"); runMigrations(db); const repos = createRepositories(db);
    repos.domains.create({ domain: "domain.com", allocationModes: ["self", "random"] });
    const addressService = { register: () => { throw new Error("SQLITE_CONSTRAINT at /srv/app/data.db"); } };
    const app = createServer({ port: 0, baseUrl: "http://localhost", minSendable: 1_000, maxSendable: 1_000_000 }, { repos, addressService, logger } as never);
    const res = await request(app).post("/lnurl/address").set("Host", "domain.com").send({ token: "ab".repeat(32) });
    expect(res.status).toBe(500);
    expect(res.text).not.toMatch(/SQLITE|\.ts:\d+/);
  });

});
