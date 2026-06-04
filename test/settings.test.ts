import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { SettingsRepo } from "../src/db/repositories/settings.js";
import { SettingsService, SettingsError, staticSettings } from "../src/settings.js";

const DEFAULTS = { minSendable: 1000, maxSendable: 100_000_000, invoiceTimeoutMs: 30_000, baseUrl: "https://x.test", registrationRateLimitPerMin: 10 };
let db: Db;
let svc: SettingsService;
beforeEach(() => { db = openDb(":memory:"); runMigrations(db); svc = new SettingsService(new SettingsRepo(db), DEFAULTS); });

describe("SettingsService", () => {
  it("returns env defaults when no override is set", () => {
    expect(svc.minSendable()).toBe(1000);
    expect(svc.baseUrl()).toBe("https://x.test");
    expect(svc.view().minSendable).toMatchObject({ value: 1000, default: 1000, overridden: false });
  });

  it("applies and clears overrides", () => {
    svc.set("minSendable", 2500);
    expect(svc.minSendable()).toBe(2500);
    expect(svc.view().minSendable).toMatchObject({ value: 2500, default: 1000, overridden: true });
    svc.clear("minSendable");
    expect(svc.minSendable()).toBe(1000);
    expect(svc.view().minSendable.overridden).toBe(false);
  });

  it("persists overrides across instances (DB-backed)", () => {
    svc.set("invoiceTimeoutMs", 5000);
    const reloaded = new SettingsService(new SettingsRepo(db), DEFAULTS);
    expect(reloaded.invoiceTimeoutMs()).toBe(5000);
  });

  it("validates positive integers and http(s) URLs", () => {
    expect(() => svc.set("minSendable", -5)).toThrow(SettingsError);
    expect(() => svc.set("minSendable", 1.5)).toThrow(SettingsError);
    expect(() => svc.set("baseUrl", "ftp://x")).toThrow(SettingsError);
    svc.set("baseUrl", "https://new.test");
    expect(svc.baseUrl()).toBe("https://new.test");
  });
});

describe("staticSettings", () => {
  it("returns the fixed defaults", () => {
    const s = staticSettings(DEFAULTS);
    expect(s.maxSendable()).toBe(100_000_000);
    expect(s.baseUrl()).toBe("https://x.test");
  });
});
