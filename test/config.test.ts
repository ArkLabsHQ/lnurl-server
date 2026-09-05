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
      SOLVER_URL: "https://solver.example",
      COVCLAIMD_URL: "https://covclaimd.example:7071",
      ARK_SERVER_URL: "https://mutinynet.arkade.sh",
    });
    expect(on.offlineReceive).toEqual({
      enabled: true,
      stampClaimPacket: false,
      solverUrl: "https://solver.example",
      covclaimdUrl: "https://covclaimd.example:7071",
      arkServerUrl: "https://mutinynet.arkade.sh",
    });
    // Opt-in, exact string only: an older solver strands a stamped packet.
    expect(loadConfig({ ...base, OFFLINE_STAMP_CLAIM_PACKET: "true" }).offlineReceive.stampClaimPacket).toBe(true);
    expect(loadConfig({ ...base, OFFLINE_STAMP_CLAIM_PACKET: "1" }).offlineReceive.stampClaimPacket).toBe(false);

    // partial config → disabled (missing covclaimd + operator)
    expect(loadConfig({ ...base, SOLVER_URL: "https://solver.example" }).offlineReceive.enabled).toBe(false);
  });

  it("enables offline receive via the Nostr solver transport (pubkey + relays)", () => {
    const on = loadConfig({
      ...base,
      SOLVER_PUBKEY: "3f831510a6d7678d0c90d7d6fbc4057720517e2e30681ef4c87cc57aaf57e8d5",
      NOSTR_RELAYS: "wss://nostr.arkade.sh, wss://relay.example",
      COVCLAIMD_URL: "https://covclaimd.example:7071",
      ARK_SERVER_URL: "https://mutinynet.arkade.sh",
    });
    expect(on.offlineReceive).toMatchObject({
      enabled: true,
      solverPubkey: "3f831510a6d7678d0c90d7d6fbc4057720517e2e30681ef4c87cc57aaf57e8d5",
      nostrRelays: ["wss://nostr.arkade.sh", "wss://relay.example"],
    });
    // pubkey without relays is not a transport
    expect(
      loadConfig({
        ...base,
        SOLVER_PUBKEY: "3f831510a6d7678d0c90d7d6fbc4057720517e2e30681ef4c87cc57aaf57e8d5",
        COVCLAIMD_URL: "https://covclaimd.example:7071",
        ARK_SERVER_URL: "https://mutinynet.arkade.sh",
      }).offlineReceive.enabled,
    ).toBe(false);
  });

  it("accepts ws:// relays (regtest/dev) but rejects non-WS schemes at load", () => {
    const dev = loadConfig({
      ...base,
      SOLVER_PUBKEY: "3f831510a6d7678d0c90d7d6fbc4057720517e2e30681ef4c87cc57aaf57e8d5",
      NOSTR_RELAYS: "ws://localhost:7777",
      COVCLAIMD_URL: "https://covclaimd.example:7071",
      ARK_SERVER_URL: "https://mutinynet.arkade.sh",
    });
    expect(dev.offlineReceive.nostrRelays).toEqual(["ws://localhost:7777"]);
    expect(() =>
      loadConfig({
        ...base,
        SOLVER_PUBKEY: "3f831510a6d7678d0c90d7d6fbc4057720517e2e30681ef4c87cc57aaf57e8d5",
        NOSTR_RELAYS: "http://relay.example",
        COVCLAIMD_URL: "https://covclaimd.example:7071",
        ARK_SERVER_URL: "https://mutinynet.arkade.sh",
      }),
    ).toThrow(/ws\(s\):\/\//);
  });

  it("enables offline receive via a solver registry index URL", () => {
    const on = loadConfig({
      ...base,
      SOLVER_REGISTRY_URL: "https://arkade-os.github.io/solver-registry/mutinynet.json",
      COVCLAIMD_URL: "https://covclaimd.example:7071",
      ARK_SERVER_URL: "https://mutinynet.arkade.sh",
    });
    expect(on.offlineReceive).toMatchObject({
      enabled: true,
      registryUrl: "https://arkade-os.github.io/solver-registry/mutinynet.json",
    });
  });
});
