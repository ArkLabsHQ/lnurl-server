import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const base = { PORT: "3000", BASE_URL: "http://localhost:3000" };

describe("loadConfig", () => {
  it("defaults to in-memory mode (no dbPath) when DB_PATH is unset", () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.dbPath).toBeUndefined();
    expect(cfg.adminPort).toBe(3001);
    expect(cfg.adminBind).toBe("127.0.0.1");
  });

  it("parses a 32-byte hex encryption key when DB is enabled", () => {
    const cfg = loadConfig({ ...base, DB_PATH: "/data/x.db", TOKEN_ENCRYPTION_KEY: "ab".repeat(32) });
    expect(cfg.dbPath).toBe("/data/x.db");
    expect(cfg.tokenEncryptionKey?.length).toBe(32);
  });

  it("throws when DB is enabled without a key and insecure storage is not allowed", () => {
    expect(() => loadConfig({ ...base, DB_PATH: "/data/x.db" })).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });

  it("allows missing key when ALLOW_INSECURE_TOKEN_STORAGE=1", () => {
    const cfg = loadConfig({ ...base, DB_PATH: "/data/x.db", ALLOW_INSECURE_TOKEN_STORAGE: "1" });
    expect(cfg.allowInsecureTokenStorage).toBe(true);
    expect(cfg.tokenEncryptionKey).toBeUndefined();
  });

  it("rejects a key that is not 32 bytes", () => {
    expect(() => loadConfig({ ...base, DB_PATH: "/data/x.db", TOKEN_ENCRYPTION_KEY: "abcd" })).toThrow(/32 bytes/);
  });

  it("reads VERIFY_TTL_MS with a 24h default", () => {
    expect(loadConfig({ ...base }).verifyTtlMs).toBe(86_400_000);
    expect(loadConfig({ ...base, VERIFY_TTL_MS: "1000" }).verifyTtlMs).toBe(1000);
  });

  it("reads offline-receive config and reports enabled only when all three are set", () => {
    const off = loadConfig({ ...base });
    expect(off.offlineReceive.enabled).toBe(false);

    const on = loadConfig({
      ...base,
      BOLTZ_URL: "https://boltz.example",
      COVCLAIMD_URL: "https://covclaimd.example:7071",
      ARK_NETWORK: "mutinynet",
    });
    expect(on.offlineReceive).toEqual({
      enabled: true,
      boltzUrl: "https://boltz.example",
      covclaimdUrl: "https://covclaimd.example:7071",
      arkNetwork: "mutinynet",
    });

    // partial config → disabled (missing covclaimd + network)
    expect(loadConfig({ ...base, BOLTZ_URL: "https://boltz.example" }).offlineReceive.enabled).toBe(false);
  });
});
