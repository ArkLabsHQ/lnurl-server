import { describe, it, expect } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import express from "express";
import request from "supertest";
import { assertFixedFloatNetwork, loadConfig } from "../src/config.js";
import { ConfigError } from "../src/errors.js";
import { openDb } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories } from "../src/db/repositories/index.js";
import { AddressService } from "../src/services/addresses.js";
import { SessionManager } from "../src/services/sessions.js";
import { SettingsService } from "../src/services/settings.js";
import { DbSettlementStore } from "../src/settlement-store.js";
import { FfOrderStore } from "../src/ff-order-store.js";
import { createAdminApi } from "../src/http/routes/admin/index.js";
import { FIXEDFLOAT } from "../src/rails/fixedfloat/provider.js";
import { FfBudget, ffClient } from "../src/rails/fixedfloat/client.js";
import { startFixedFloat } from "../src/rails/fixedfloat/wiring.js";
import { createLogger } from "../src/logger.js";
import { fakeFixedFloat } from "./helpers/fake-fixedfloat.js";
import { pollUntil } from "./e2e/support/regtest.js";

const KEY = "ff-test-key-0123456789";
const SECRET = "ff-test-secret-9876543210";
const BASE = { PORT: "3000", BASE_URL: "http://localhost:3000" };
const OFFLINE = { ...BASE, ARK_SERVER_URL: "https://ark.invalid", COVCLAIMD_URL: "https://cov.invalid", SOLVER_REGISTRY_URLS: "https://registry.invalid" };
const PERSISTED = { ...OFFLINE, DB_PATH: "/data/lnurl.db", ALLOW_INSECURE_TOKEN_STORAGE: "1" };
const LIVE = { ...PERSISTED, FIXEDFLOAT_API_KEY: KEY, FIXEDFLOAT_API_SECRET: SECRET };

describe("FixedFloat config", () => {
  it("the rail is off and advertised nowhere with no FF env", () => {
    expect(loadConfig(PERSISTED).fixedFloat).toBeUndefined();
  });

  it("an api key without a secret is a ConfigError", () => {
    expect(() => loadConfig({ ...PERSISTED, FIXEDFLOAT_API_KEY: KEY })).toThrow(ConfigError);
    expect(() => loadConfig({ ...PERSISTED, FIXEDFLOAT_API_SECRET: SECRET })).toThrow(/FIXEDFLOAT_API_KEY and FIXEDFLOAT_API_SECRET/);
  });

  it("FF keys on a non-bitcoin network are a ConfigError naming the network", () => {
    const cfg = loadConfig(LIVE).fixedFloat;
    expect(() => assertFixedFloatNetwork(cfg, "mutinynet")).toThrow(ConfigError);
    expect(() => assertFixedFloatNetwork(cfg, "mutinynet")).toThrow(/mutinynet/);
    expect(() => assertFixedFloatNetwork(cfg, "bitcoin")).not.toThrow();
    expect(() => assertFixedFloatNetwork(undefined, "mutinynet")).not.toThrow();
  });

  it("FF keys without DB_PATH are a ConfigError", () => {
    expect(() => loadConfig({ ...OFFLINE, FIXEDFLOAT_API_KEY: KEY, FIXEDFLOAT_API_SECRET: SECRET })).toThrow(/DB_PATH/);
  });

  it("FF without offline receive is a ConfigError: the corridor is what pays the order", () => {
    expect(() => loadConfig({ ...BASE, DB_PATH: "/data/lnurl.db", ALLOW_INSECURE_TOKEN_STORAGE: "1", FIXEDFLOAT_API_KEY: KEY, FIXEDFLOAT_API_SECRET: SECRET }))
      .toThrow(/offline receive/);
  });

  it("FIXEDFLOAT_SIMULATE with real keys is a ConfigError", () => {
    expect(() => loadConfig({ ...LIVE, FIXEDFLOAT_SIMULATE: "true" })).toThrow(/FIXEDFLOAT_SIMULATE/);
  });

  it("FIXEDFLOAT_SIMULATE on bitcoin is a ConfigError", () => {
    const cfg = loadConfig({ ...PERSISTED, FIXEDFLOAT_SIMULATE: "true" }).fixedFloat;
    expect(cfg?.mode).toBe("simulate");
    expect(() => assertFixedFloatNetwork(cfg, "bitcoin")).toThrow(/FIXEDFLOAT_SIMULATE/);
    expect(() => assertFixedFloatNetwork(cfg, "mutinynet")).not.toThrow();
  });

  it("takes only an explicit true or false for FIXEDFLOAT_SIMULATE", () => {
    expect(() => loadConfig({ ...PERSISTED, FIXEDFLOAT_SIMULATE: "1" })).toThrow(/FIXEDFLOAT_SIMULATE/);
    expect(loadConfig({ ...PERSISTED, FIXEDFLOAT_SIMULATE: "false" }).fixedFloat).toBeUndefined();
  });

  it("defaults come from loadConfig, not from literals", () => {
    const cfg = loadConfig(LIVE).fixedFloat!;
    expect(cfg).toMatchObject({
      mode: "live", baseUrl: "https://ff.io/api/v2", ratesUrl: "https://ff.io/rates/fixed.xml",
      settleMarginSeconds: 600, minPayWindowSeconds: 300, refreshMs: 300_000, maxOpenOrders: 20, deny: [],
      maxOpenOrdersPerAddress: 5, ordersPerIp: 10, ipWindowSeconds: 600,
    });
    expect(cfg.allow).toBeUndefined();
    // intent-solver mints its hold invoice for 2h - 90min (DEFAULT_HOLD_INVOICE_WINDOW): the
    // shipped pre-check must fit under it, or every token deposit is refused.
    expect(cfg.settleMarginSeconds + cfg.minPayWindowSeconds).toBeLessThan(1_800);
  });

  it("reads allow, deny, refcode and afftax, refusing a code the asset table lacks", () => {
    const cfg = loadConfig({ ...LIVE, FIXEDFLOAT_ALLOW: "usdtarbitrum, USDTSOL", FIXEDFLOAT_DENY: "USDTSOL", FIXEDFLOAT_REFCODE: "ref", FIXEDFLOAT_AFFTAX: "0.5" }).fixedFloat!;
    expect(cfg).toMatchObject({ allow: ["USDTARBITRUM", "USDTSOL"], deny: ["USDTSOL"], refcode: "ref", afftax: 0.5 });
    expect(() => loadConfig({ ...LIVE, FIXEDFLOAT_ALLOW: "USDTBSC" })).toThrow(/USDTBSC/);
    expect(() => loadConfig({ ...LIVE, FIXEDFLOAT_AFFTAX: "-1" })).toThrow(/FIXEDFLOAT_AFFTAX/);
  });

  it("the loaded config object does not contain the secret under any key", () => {
    const cfg = loadConfig(LIVE);
    const seen = new Set<unknown>();
    const walk = (value: unknown, path: string): void => {
      if (typeof value === "string") {
        expect(value, path).not.toContain(SECRET);
        expect(value, path).not.toContain(KEY);
      }
      if (value && typeof value === "object" && !seen.has(value)) {
        seen.add(value);
        for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
      }
    };
    walk(cfg, "config");
    expect(JSON.stringify(cfg)).not.toContain(SECRET);
    // Still signs with it.
    expect(cfg.fixedFloat?.auth?.headers("{}")["X-API-SIGN"]).toBe(createHmac("sha256", SECRET).update("{}").digest("hex"));
  });
});

describe("startFixedFloat", () => {
  it("wires a live provider to the configured API and rates URLs, and stops cleanly", async () => {
    const ff = await fakeFixedFloat({ apiKey: KEY, secret: SECRET });
    const db = openDb(":memory:");
    runMigrations(db);
    try {
      const config = loadConfig({ ...LIVE, FIXEDFLOAT_BASE_URL: ff.baseUrl, FIXEDFLOAT_RATES_URL: ff.ratesUrl }).fixedFloat!;
      const started = startFixedFloat({ config, db, ttlMs: 86_400_000, logger: createLogger({ info: () => {}, warn: () => {}, error: () => {} }) });
      await pollUntil("token rates", async () => started.deps.rates.snapshot().ready, 10_000, 20);
      expect(started.deps.provider.label).toBe("FixedFloat");
      expect(started.deps.rates.snapshot().rails.map((r) => r.optionId)).toContain("ff-usdtarbitrum");
      expect(ff.calls.map((c) => c.method)).toEqual(["ccies"]);
      started.stop();
    } finally {
      db.close();
      await ff.close();
    }
  });
});

describe("FixedFloat in the admin API", () => {
  it("shows the rail's state and each order's id, never its token", async () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const repos = createRepositories(db);
    const config = loadConfig(OFFLINE);
    const settings = new SettingsService(repos.settings, {
      minSendable: config.minSendable, maxSendable: config.maxSendable, invoiceTimeoutMs: config.invoiceTimeoutMs,
      baseUrl: config.baseUrl, registrationRateLimitPerMin: config.registrationRateLimitPerMin,
    });
    const orders = new FfOrderStore(db, 86_400_000);
    orders.createAccepted({
      paymentHash: "aa".repeat(32), pr: "lnbc1", sessionId: "offline:1", preimage: "bb".repeat(32), amountMsat: 10_000_000, paymentOption: "ff-usdtarbitrum",
      recovery: { version: 1, solverName: "s", solverPubkey: "11".repeat(32), relays: ["wss://relay.example"], rfqId: "rfq-1", lockupAddress: "tark1x", expectedAmount: 9_980, script: {} },
      order: { id: "AB12CD", token: "secret-order-token", ffCode: "USDTARBITRUM", asset: "eip155:42161/erc20:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9",
        unit: "USDT", depositAddress: "0x" + "ab".repeat(20), depositAmount: "8426000", invoiceAmountSat: 10_000, status: "NEW", expiresAt: 1_900_000_000 },
    });
    const fixedFloat = {
      provider: FIXEDFLOAT, rates: { snapshot: () => ({ rails: [], ready: false, reason: "FixedFloat rates not loaded yet" }) },
      client: ffClient({ transport: { call: async () => { throw new Error("unused"); } }, budget: new FfBudget() }),
      orders, settleMarginSeconds: 600, minPayWindowSeconds: 300, maxOpenOrders: 20, maxOpenOrdersPerAddress: 2, ordersPerIp: 2, ipWindowSeconds: 600,
    };
    const app = express();
    app.use("/admin/api", createAdminApi({
      repos, addressService: new AddressService(repos, randomBytes(32)), sessions: new SessionManager(), settings, config,
      settlements: new DbSettlementStore(db, 86_400_000), fixedFloat,
    }));
    const rails = await request(app).get("/admin/api/rails");
    expect(rails.body.rails.find((r: { id: string }) => r.id === "fixedfloat")).toMatchObject({
      label: "Token deposits (FixedFloat)", configured: true, ready: false, reason: "FixedFloat rates not loaded yet",
    });
    const list = await request(app).get("/admin/api/settlements");
    expect(list.body[0].ffOrder).toEqual({
      id: "AB12CD", status: "NEW", ffCode: "USDTARBITRUM", unit: "USDT", depositAmount: "8426000", depositTxid: null,
      expiresAt: 1_900_000_000, hasToken: true, emergency: null,
    });
    expect(JSON.stringify(list.body)).not.toContain("secret-order-token");
    db.close();
  });
});
