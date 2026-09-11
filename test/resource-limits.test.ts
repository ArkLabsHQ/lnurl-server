import { describe, expect, it } from "vitest";
import request from "supertest";
import { PassThrough } from "node:stream";
import type { Response } from "express";
import { SessionManager } from "../src/session-manager.js";
import { createServer } from "../src/server.js";

describe("resource limits", () => {
  it("rejects an SSE connection above the per-IP cap before opening the stream", async () => {
    const sessions = new SessionManager();
    sessions.create(new PassThrough() as unknown as Response, undefined, "1.2.3.4");
    const app = createServer({
      port: 0, baseUrl: "http://localhost", minSendable: 1_000, maxSendable: 1_000_000,
      trustProxy: 1, maxSessions: 10, maxSessionsPerIp: 1,
    }, { sessions } as never);
    const res = await request(app).post("/lnurl/session").set("X-Forwarded-For", "1.2.3.4").send({});
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/session limit/i);
    expect(res.headers["x-powered-by"]).toBeUndefined();
    sessions.shutdown("test");
  });

  it("rejects oversized JSON bodies", async () => {
    const app = createServer({ port: 0, baseUrl: "http://localhost", minSendable: 1_000, maxSendable: 1_000_000 });
    expect((await request(app).post("/lnurl/session").send({ token: "a".repeat(70_000) })).status).toBe(413);
  });
});
