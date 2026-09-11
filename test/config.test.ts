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

  it("reads card-only offline-receive config", () => {
    const off = loadConfig({ ...base });
    expect(off.offlineReceive.enabled).toBe(false);

    const on = loadConfig({
      ...base,
      SOLVER_REGISTRY_URLS: "https://one.example/mutinynet.json, https://two.example/mutinynet.json",
      SOLVER_CARDS_FILE: "/run/config/solvers.json",
      COVCLAIMD_URL: "https://covclaimd.example:7071",
      ARK_SERVER_URL: "https://mutinynet.arkade.sh",
    });
    expect(on.offlineReceive).toEqual({
      enabled: true,
      stampClaimPacket: false,
      selfClaim: false,
      registryUrls: ["https://one.example/mutinynet.json", "https://two.example/mutinynet.json"],
      cardsFile: "/run/config/solvers.json",
      covclaimdUrl: "https://covclaimd.example:7071",
      arkServerUrl: "https://mutinynet.arkade.sh",
    });
    // Opt-in, exact string only: an older solver strands a stamped packet.
    expect(loadConfig({
      ...base,
      SOLVER_CARDS_FILE: "/cards.json",
      COVCLAIMD_URL: "https://covclaimd.example",
      ARK_SERVER_URL: "https://ark.example",
      OFFLINE_STAMP_CLAIM_PACKET: "true",
    }).offlineReceive.stampClaimPacket).toBe(true);
    expect(loadConfig({ ...base, OFFLINE_STAMP_CLAIM_PACKET: "1" }).offlineReceive.stampClaimPacket).toBe(false);

    expect(() => loadConfig({ ...base, SOLVER_CARDS_FILE: "/cards.json" })).toThrow(/COVCLAIMD_URL.*ARK_SERVER_URL/);
  });

  it.each(["SOLVER_URL", "SOLVER_PUBKEY", "NOSTR_RELAYS", "SOLVER_REGISTRY_URL"])(
    "rejects removed %s configuration",
    (name) => expect(() => loadConfig({ ...base, [name]: "configured" })).toThrow(new RegExp(`${name}.*removed`, "i")),
  );

  it.each([
    ["PORT", "0"],
    ["PORT", "abc"],
    ["MIN_SENDABLE", "-1"],
    ["MAX_SENDABLE", "1.5"],
    ["INVOICE_TIMEOUT_MS", "NaN"],
  ])("rejects invalid %s=%s", (name, value) => {
    expect(() => loadConfig({ ...base, [name]: value })).toThrow(name);
  });

  it("reads the self-claim flag and its emulator URL, and fails loudly without one", () => {
    const on = loadConfig({
      ...base,
      SOLVER_CARDS_FILE: "/cards.json",
      COVCLAIMD_URL: "https://covclaimd.example",
      ARK_SERVER_URL: "https://ark.example",
      OFFLINE_SELF_CLAIM: "true",
      OFFLINE_EMULATOR_URL: "https://emulator.example",
    });
    expect(on.offlineReceive.selfClaim).toBe(true);
    expect(on.offlineReceive.emulatorUrl).toBe("https://emulator.example");
    // No key: the covenant leaf is signed by the operator and the emulator.
    expect(on.offlineReceive).not.toHaveProperty("selfClaimKey");

    // Opt-in, exact string only — same discipline as the stamp flag.
    expect(loadConfig({ ...base }).offlineReceive.selfClaim).toBe(false);
    expect(loadConfig({
      ...base,
      SOLVER_CARDS_FILE: "/cards.json",
      COVCLAIMD_URL: "https://covclaimd.example",
      ARK_SERVER_URL: "https://ark.example",
      OFFLINE_SELF_CLAIM: "1",
    }).offlineReceive.selfClaim).toBe(false);

    expect(() => loadConfig({ ...base, OFFLINE_SELF_CLAIM: "true" })).toThrow(/OFFLINE_EMULATOR_URL/);
    expect(() => loadConfig({ ...base, OFFLINE_EMULATOR_URL: "emulator.example" })).toThrow(/http\(s\)/);
  });

  it("rejects malformed registry and dependency URLs", () => {
    expect(() => loadConfig({ ...base, SOLVER_REGISTRY_URLS: "ftp://registry.example" })).toThrow(/SOLVER_REGISTRY_URLS/);
    expect(() => loadConfig({ ...base, COVCLAIMD_URL: "covclaimd.example" })).toThrow(/COVCLAIMD_URL/);
  });
});
