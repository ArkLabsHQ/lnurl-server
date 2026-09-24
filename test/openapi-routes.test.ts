import { describe, it, expect } from "vitest";
import request from "supertest";
import { randomBytes } from "node:crypto";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { AddressService } from "../src/services/addresses.js";
import { SessionManager } from "../src/services/sessions.js";
import { SettingsService } from "../src/services/settings.js";
import { loadConfig } from "../src/config.js";
import { DbSettlementStore } from "../src/settlement-store.js";
import { createServer } from "../src/server.js";
import { createAdminServer } from "../src/admin-server.js";
import { openApiSpec } from "../src/openapi.js";
import { adminOpenApiSpec } from "../src/admin-openapi.js";

/**
 * Endpoints that serve the specs/docs themselves and are deliberately absent from them:
 * documenting a spec on the spec it returns is circular, and the two docs pages are HTML.
 * Anything else a router registers must appear in the matching spec's paths[method].
 */
const PUBLIC_META = new Set(["GET /", "GET /openapi.json"]);
const ADMIN_META = new Set(["GET /openapi.json", "GET /docs"]);

const OPERATIONS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "trace"]);

interface LayerLike {
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: unknown[] };
}

/** Express 5 exposes the router on `app.router` (the v4 `app._router` is gone). */
function collectRoutes(app: unknown): Set<string> {
  const routes = new Set<string>();
  const visit = (layers: unknown[]): void => {
    for (const layer of layers as LayerLike[]) {
      if (layer.route) {
        const path = layer.route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
        for (const [method, enabled] of Object.entries(layer.route.methods)) {
          if (enabled && OPERATIONS.has(method)) routes.add(`${method.toUpperCase()} ${path}`);
        }
      } else if (Array.isArray(layer.handle?.stack)) {
        // A mounted router (e.g. /admin/api) has no route of its own.
        visit(layer.handle.stack);
      }
    }
  };
  visit((app as { router?: { stack?: unknown[] } }).router?.stack ?? []);
  return routes;
}

function specOperations(spec: { paths: Record<string, object> }): Set<string> {
  const ops = new Set<string>();
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of Object.keys(item)) {
      if (OPERATIONS.has(method)) ops.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return ops;
}

function expectNoDrift(label: string, app: unknown, spec: { paths: Record<string, object> }, meta: Set<string>): void {
  const registered = collectRoutes(app);
  const documented = specOperations(spec);
  // A guard that cannot fail is worthless: both directions are asserted, so a broken
  // introspection (empty `registered`) fails loudly instead of passing vacuously.
  expect([...registered].filter((op) => !documented.has(op) && !meta.has(op)).sort(), `${label}: registered but undocumented`).toEqual([]);
  expect([...documented].filter((op) => !registered.has(op)).sort(), `${label}: documented but not registered`).toEqual([]);
}

interface Fixture {
  db: Db;
  repos: Repositories;
  publicApp: ReturnType<typeof createServer>;
  adminApp: ReturnType<typeof createAdminServer>;
}

function buildFixture(): Fixture {
  const db = openDb(":memory:");
  runMigrations(db);
  const repos = createRepositories(db);
  const addressService = new AddressService(repos, randomBytes(32));
  const sessions = new SessionManager();
  const config = loadConfig({ PORT: "3000", BASE_URL: "http://localhost:3000" });
  const settings = new SettingsService(repos.settings, {
    minSendable: config.minSendable, maxSendable: config.maxSendable, invoiceTimeoutMs: config.invoiceTimeoutMs,
    baseUrl: config.baseUrl, registrationRateLimitPerMin: config.registrationRateLimitPerMin,
  });
  const settlements = new DbSettlementStore(db, 86_400_000);
  const publicApp = createServer(
    { port: 0, baseUrl: "http://localhost:3000", minSendable: 1000, maxSendable: 100_000_000, invoiceTimeoutMs: 3000 },
    { repos, addressService, sessions, settlements },
  );
  const adminApp = createAdminServer({ repos, addressService, sessions, settings, config, settlements });
  return { db, repos, publicApp, adminApp };
}

describe("OpenAPI specs vs registered routes", () => {
  it("documents every route createServer registers", () => {
    const { publicApp } = buildFixture();
    expectNoDrift("public", publicApp, openApiSpec, PUBLIC_META);
  });

  it("documents every route createAdminServer registers", () => {
    const { adminApp } = buildFixture();
    expectNoDrift("admin", adminApp, adminOpenApiSpec, ADMIN_META);
  });

  it("serves both specs through the real HTTP apps", async () => {
    const { publicApp, adminApp } = buildFixture();
    const pub = await request(publicApp).get("/openapi.json");
    expect(pub.status).toBe(200);
    expect(pub.body.openapi).toBe("3.0.3");
    expect(pub.body.paths["/livez"]).toBeDefined();
    expect(pub.body.paths["/readyz"]).toBeDefined();

    const admin = await request(adminApp).get("/admin/api/openapi.json");
    expect(admin.status).toBe(200);
    expect(admin.body.openapi).toBe("3.0.3");
    expect(admin.body.paths["/settings"]?.patch).toBeDefined();
  });
});
