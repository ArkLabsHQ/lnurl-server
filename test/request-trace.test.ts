import { describe, it, expect } from "vitest";
import http from "node:http";
import request from "supertest";
import { randomBytes } from "node:crypto";
import { createServer } from "../src/server.js";
import { createAdminServer } from "../src/admin-server.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories } from "../src/db/repositories/index.js";
import { AddressService } from "../src/services/addresses.js";
import { SessionManager } from "../src/services/sessions.js";
import { SettingsService } from "../src/services/settings.js";
import type { Logger } from "../src/logger.js";

type LogLine = { event: string; fields: Record<string, unknown> };

function captureLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  return {
    lines,
    logger: {
      info: (event, fields = {}) => lines.push({ event, fields }),
      warn: () => {},
      error: () => {},
    },
  };
}

async function until<T>(check: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function startPublicServer(logger: Logger, traceRequests: boolean) {
  const server = http.createServer();
  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${port}`;
      const app = createServer(
        { port: 0, baseUrl, minSendable: 1_000, maxSendable: 100_000_000, traceRequests },
        { logger } as never,
      );
      server.removeAllListeners("request");
      server.on("request", app);
      resolve({
        baseUrl,
        close: () =>
          new Promise<void>((res) => {
            server.closeAllConnections();
            server.close(() => res());
          }),
      });
    });
  });
}

function get(url: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on("error", reject);
  });
}

describe("request tracing", () => {
  it("logs one completion line per public request, including unmatched 404s", async () => {
    const { logger, lines } = captureLogger();
    const ctx = await startPublicServer(logger, true);
    try {
      const hit = await get(`${ctx.baseUrl}/livez`, {
        host: "lnurl.example",
        "x-forwarded-for": "203.0.113.7",
        "x-forwarded-proto": "https",
        "x-real-ip": "203.0.113.7",
      });
      const miss = await get(`${ctx.baseUrl}/not-a-route`, { host: "lnurl.example" });
      expect(hit.status).toBe(200);
      expect(miss.status).toBe(404);

      const traced = await until(() => (lines.length >= 2 ? lines : undefined));
      expect(traced.map((line) => line.event)).toEqual(["http_request", "http_request"]);

      const served = traced.find((line) => line.fields.path === "/livez")!;
      expect(served.fields).toMatchObject({
        method: "GET",
        path: "/livez",
        host: "lnurl.example",
        status: 200,
        requestId: hit.headers["x-request-id"],
        forwardedFor: "203.0.113.7",
        forwardedProto: "https",
        realIp: "203.0.113.7",
      });
      expect(served.fields.durationMs).toBeGreaterThan(0);

      const unmatched = traced.find((line) => line.fields.path === "/not-a-route")!;
      expect(unmatched.fields).toMatchObject({ method: "GET", status: 404 });
    } finally {
      await ctx.close();
    }
  });

  it("emits no request logs when tracing is off", async () => {
    const { logger, lines } = captureLogger();
    const ctx = await startPublicServer(logger, false);
    try {
      await get(`${ctx.baseUrl}/livez`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(lines).toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  it("traces the admin server through the injected logger", async () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const repos = createRepositories(db);
    const { logger, lines } = captureLogger();
    const config = { ...loadConfig({ PORT: "3000", BASE_URL: "http://localhost:3000" }), traceRequests: true };
    const settings = new SettingsService(repos.settings, {
      minSendable: config.minSendable,
      maxSendable: config.maxSendable,
      invoiceTimeoutMs: config.invoiceTimeoutMs,
      baseUrl: config.baseUrl,
      registrationRateLimitPerMin: config.registrationRateLimitPerMin,
    });
    const app = createAdminServer(
      {
        repos,
        addressService: new AddressService(repos, randomBytes(32)),
        sessions: new SessionManager(),
        settings,
        config,
        logger,
      },
      "no-such-admin-ui",
    );

    const hit = await request(app).get("/admin/api/domains").set("Host", "admin.example");
    const miss = await request(app).get("/not-a-route");
    expect(hit.status).toBe(200);
    expect(miss.status).toBe(404);

    const traced = await until(() => (lines.length >= 2 ? lines : undefined));
    const served = traced.find((line) => line.fields.path === "/admin/api/domains")!;
    expect(served).toMatchObject({ event: "http_request", fields: { method: "GET", host: "admin.example", status: 200 } });
    expect(traced.find((line) => line.fields.path === "/not-a-route")!.fields.status).toBe(404);
  });
});
