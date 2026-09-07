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
      selfClaim: false,
      covenantDestinations: false,
      covenantRecoveryDelaySeconds: 86_528,
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

  it("reads the self-claim flag and its emulator URL, and fails loudly without one", () => {
    const on = loadConfig({ ...base, OFFLINE_SELF_CLAIM: "true", OFFLINE_EMULATOR_URL: "https://emulator.example" });
    expect(on.offlineReceive.selfClaim).toBe(true);
    expect(on.offlineReceive.emulatorUrl).toBe("https://emulator.example");
    // No key: the covenant leaf is signed by the operator and the emulator.
    expect(on.offlineReceive).not.toHaveProperty("selfClaimKey");

    // Opt-in, exact string only — same discipline as the stamp flag.
    expect(loadConfig({ ...base }).offlineReceive.selfClaim).toBe(false);
    expect(loadConfig({ ...base, OFFLINE_SELF_CLAIM: "1", OFFLINE_EMULATOR_URL: "https://e.example" }).offlineReceive.selfClaim).toBe(false);

    expect(() => loadConfig({ ...base, OFFLINE_SELF_CLAIM: "true" })).toThrow(/OFFLINE_EMULATOR_URL/);
    expect(() => loadConfig({ ...base, OFFLINE_EMULATOR_URL: "emulator.example" })).toThrow(/http\(s\)/);
  });

  it("reads the covenant-destination flag, and refuses a config nothing could sweep", () => {
    const withUrls = { ...base, COVCLAIMD_URL: "https://cc.example", ARK_SERVER_URL: "https://ark.example" };
    const on = loadConfig({
      ...withUrls,
      OFFLINE_COVENANT_DESTINATIONS: "true",
      OFFLINE_EMULATOR_URL: "https://emulator.example",
    });
    expect(on.offlineReceive.covenantDestinations).toBe(true);
    expect(on.offlineReceive.covenantRecoveryDelaySeconds).toBe(86_528);

    expect(loadConfig({ ...base }).offlineReceive.covenantDestinations).toBe(false);
    expect(
      loadConfig({ ...withUrls, OFFLINE_COVENANT_DESTINATIONS: "1", OFFLINE_EMULATOR_URL: "https://e.example" })
        .offlineReceive.covenantDestinations,
    ).toBe(false);

    // A payer must never be handed an address nothing can sweep, so both the
    // emulator and the keys the covenant commits to are required up front.
    expect(() => loadConfig({ ...withUrls, OFFLINE_COVENANT_DESTINATIONS: "true" })).toThrow(/OFFLINE_EMULATOR_URL/);
    expect(() =>
      loadConfig({ ...base, OFFLINE_COVENANT_DESTINATIONS: "true", OFFLINE_EMULATOR_URL: "https://emulator.example" }),
    ).toThrow(/COVCLAIMD_URL and ARK_SERVER_URL/);
  });

  it("rejects a non-positive covenant recovery delay rather than building an unspendable leaf", () => {
    const withFlag = (v: string) => ({
      ...base,
      COVCLAIMD_URL: "https://cc.example",
      ARK_SERVER_URL: "https://ark.example",
      OFFLINE_COVENANT_DESTINATIONS: "true",
      OFFLINE_EMULATOR_URL: "https://emulator.example",
      OFFLINE_COVENANT_RECOVERY_DELAY_SECONDS: v,
    });
    expect(loadConfig(withFlag("4096")).offlineReceive.covenantRecoveryDelaySeconds).toBe(4096);
    expect(() => loadConfig(withFlag("0"))).toThrow(/positive integer/);
    expect(() => loadConfig(withFlag("-1"))).toThrow(/positive integer/);
    expect(() => loadConfig(withFlag("soon"))).toThrow(/positive integer/);

    // BIP68 counts seconds in 512s units and throws on anything else. That throw
    // only surfaces at per-payment derivation, which falls back to the static
    // address — so an operator would see the flag "on" and get none of it.
    expect(() => loadConfig(withFlag("86400"))).toThrow(/multiple of 512.*nearest is 86528/s);
    expect(() => loadConfig(withFlag("3600"))).toThrow(/multiple of 512/);
    expect(loadConfig(withFlag("86528")).offlineReceive.covenantRecoveryDelaySeconds).toBe(86_528);
  });

  it("ships a default recovery delay BIP68 can actually encode", () => {
    const cfg = loadConfig({
      ...base,
      COVCLAIMD_URL: "https://cc.example",
      ARK_SERVER_URL: "https://ark.example",
      OFFLINE_COVENANT_DESTINATIONS: "true",
      OFFLINE_EMULATOR_URL: "https://emulator.example",
    });
    expect(cfg.offlineReceive.covenantRecoveryDelaySeconds % 512).toBe(0);
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
