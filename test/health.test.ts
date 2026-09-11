import { describe, expect, it } from "vitest";
import request from "supertest";
import { HealthRegistry } from "../src/health.js";
import { createServer } from "../src/server.js";

const config = { port: 0, baseUrl: "http://localhost", minSendable: 1_000, maxSendable: 1_000_000 };

describe("health endpoints", () => {
  it("keeps liveness up while readiness reflects dependencies and shutdown", async () => {
    let discovery = false;
    const health = new HealthRegistry();
    health.register("discovery", () => ({ ok: discovery, detail: discovery ? "1 candidate" : "no candidates" }));
    const app = createServer(config, { health } as never);
    expect((await request(app).get("/livez")).status).toBe(200);
    expect((await request(app).get("/readyz")).status).toBe(503);
    discovery = true;
    expect((await request(app).get("/readyz")).body).toMatchObject({ status: "ready" });
    health.beginShutdown("SIGTERM");
    expect((await request(app).get("/readyz")).status).toBe(503);
    expect((await request(app).get("/livez")).status).toBe(200);
  });
});
