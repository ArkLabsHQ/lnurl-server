import { describe, expect, it } from "vitest";
import request from "supertest";
import { HealthRegistry } from "../src/health.js";
import { createServer } from "../src/server.js";

const config = { port: 0, baseUrl: "http://localhost", minSendable: 1_000, maxSendable: 1_000_000 };

function app() {
  return createServer(config, { health: new HealthRegistry() } as never);
}

describe("CORS", () => {
  it("lets a browser send X-API-Key on a preflighted registration", async () => {
    const res = await request(app())
      .options("/lnurl/address")
      .set("Origin", "https://wallet.example")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type,x-api-key");

    expect(res.status).toBeLessThan(300);
    expect(res.headers["access-control-allow-headers"]?.toLowerCase()).toContain("x-api-key");
  });

  it("exposes X-Request-Id so a browser can read the id it is told to quote", async () => {
    const res = await request(app()).get("/livez").set("Origin", "https://wallet.example");

    expect(res.headers["access-control-expose-headers"]?.toLowerCase()).toContain("x-request-id");
  });
});
