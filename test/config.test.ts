import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { ConfigError } from "../src/errors.js";

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

  it("reads the request-tracing flag, the exact string 1 only", () => {
    expect(loadConfig({ ...base }).traceRequests).toBe(false);
    expect(loadConfig({ ...base, TRACE_REQUESTS: "1" }).traceRequests).toBe(true);
    expect(loadConfig({ ...base, TRACE_REQUESTS: "true" }).traceRequests).toBe(false);
  });

  it("rejects a key that is not 32 bytes", () => {
    expect(() => loadConfig({ ...base, DB_PATH: "/data/x.db", TOKEN_ENCRYPTION_KEY: "abcd" })).toThrow(/32 bytes/);
  });

  it("trusts one proxy hop and no forwarders by default", () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.trustProxy).toBe(1);
    expect(cfg.trustedForwarders.rules).toEqual([]);
  });

  it("takes a full-length prefix as one host", () => {
    const { trustedForwarders } = loadConfig({ ...base, TRUSTED_FORWARDERS: "203.0.113.10/32, 2001:db8::1/128" });
    expect(trustedForwarders.check("203.0.113.10", "ipv4")).toBe(true);
    expect(trustedForwarders.check("203.0.113.11", "ipv4")).toBe(false);
    expect(trustedForwarders.check("2001:db8::1", "ipv6")).toBe(true);
    expect(trustedForwarders.check("2001:db8::2", "ipv6")).toBe(false);
  });

  it.each(["not-an-ip", "203.0.113.10/33", "2001:db8::/129", "10.0.0.0/0", "10.0.0.0/", "10.0.0.0/8/8", "203.0.113.10:443", "203.0.113.10 198.51.100.1"])(
    "rejects the TRUSTED_FORWARDERS entry %s",
    (entry) => {
      const load = () => loadConfig({ ...base, TRUSTED_FORWARDERS: `203.0.113.10, ${entry}` });
      expect(load).toThrow(ConfigError);
      expect(load).toThrow(/TRUSTED_FORWARDERS/);
    },
  );

  it("reads CALLBACK_RATE_LIMIT_PER_MINUTE with the 30 default", () => {
    expect(loadConfig({ ...base }).callbackRateLimitPerMin).toBe(30);
    expect(loadConfig({ ...base, CALLBACK_RATE_LIMIT_PER_MINUTE: "120" }).callbackRateLimitPerMin).toBe(120);
  });

  it("reads VERIFY_TTL_MS with a 24h default", () => {
    expect(loadConfig({ ...base }).verifyTtlMs).toBe(86_400_000);
    expect(loadConfig({ ...base, VERIFY_TTL_MS: "1000" }).verifyTtlMs).toBe(1000);
  });

  it("reads DESTINATION_LATE_SWEEP_MS with a 30d default, 0 disabling it", () => {
    expect(loadConfig({ ...base }).destinationLateSweepMs).toBe(2_592_000_000);
    expect(loadConfig({ ...base, DESTINATION_LATE_SWEEP_MS: "0" }).destinationLateSweepMs).toBe(0);
    expect(() => loadConfig({ ...base, DESTINATION_LATE_SWEEP_MS: "-1" })).toThrow(/DESTINATION_LATE_SWEEP_MS/);
  });

  it("reads OFFLINE_POLL_INTERVAL_MS with the 15s default", () => {
    expect(loadConfig({ ...base }).offlineReceive.pollIntervalMs).toBe(15_000);
    expect(loadConfig({ ...base, OFFLINE_POLL_INTERVAL_MS: "3000" }).offlineReceive.pollIntervalMs).toBe(3000);
    expect(() => loadConfig({ ...base, OFFLINE_POLL_INTERVAL_MS: "0" })).toThrow(/OFFLINE_POLL_INTERVAL_MS/);
  });

  it("reads card-only offline-receive config", () => {
    const off = loadConfig({ ...base });
    expect(off.offlineReceive.enabled).toBe(false);

    const on = loadConfig({
      ...base,
      SOLVER_REGISTRY_URLS: "https://one.example/mutinynet.json, https://two.example/mutinynet.json",
      SOLVER_CARDS_FILE: "/run/config/solvers.json",
      OFFLINE_EMULATOR_URL: "https://emulator.example",
      ARK_SERVER_URL: "https://mutinynet.arkade.sh",
    });
    expect(on.offlineReceive).toEqual({
      enabled: true,
      covenantDestinations: false,
      covenantRecoveryDelaySeconds: undefined,
      pollIntervalMs: 15_000,
      registryUrls: ["https://one.example/mutinynet.json", "https://two.example/mutinynet.json"],
      cardsFile: "/run/config/solvers.json",
      emulatorUrl: "https://emulator.example",
      arkServerUrl: "https://mutinynet.arkade.sh",
    });

    expect(() => loadConfig({ ...base, SOLVER_CARDS_FILE: "/cards.json" })).toThrow(/ARK_SERVER_URL/);
  });

  it("refuses offline receive without the emulator, naming it", () => {
    const withArk = { ...base, ARK_SERVER_URL: "https://ark.example" };
    expect(() => loadConfig({ ...withArk, SOLVER_CARDS_FILE: "/cards.json" })).toThrow(/OFFLINE_EMULATOR_URL/);
    expect(() => loadConfig({ ...withArk, SOLVER_REGISTRY_URLS: "https://r.example/m.json" })).toThrow(/OFFLINE_EMULATOR_URL/);
    expect(() => loadConfig({ ...withArk, NOSTR_SECRET_KEY: "a".repeat(64) })).toThrow(/OFFLINE_EMULATOR_URL/);
    expect(() => loadConfig({ ...withArk, SOLVER_RFQ_HTTP_URL: "http://localhost:8787" })).toThrow(/OFFLINE_EMULATOR_URL/);
  });

  it.each(["COVCLAIMD_URL", "OFFLINE_STAMP_CLAIM_PACKET"])("rejects removed %s", (name) => {
    expect(() => loadConfig({ ...base, [name]: "true" })).toThrow(new RegExp(`${name}.*removed`, "i"));
  });

  it("accepts OFFLINE_SELF_CLAIM=true and refuses turning self-claim off", () => {
    expect(() => loadConfig({ ...base, OFFLINE_SELF_CLAIM: "true" })).not.toThrow();
    expect(() => loadConfig({ ...base, OFFLINE_SELF_CLAIM: "false" })).toThrow(/OFFLINE_SELF_CLAIM/);
  });

  it("enables offline receive from ARK_SERVER_URL and OFFLINE_EMULATOR_URL, cards coming from the registry or admin DB", () => {
    const config = loadConfig({
      ...base,
      ARK_SERVER_URL: "https://ark.example",
      OFFLINE_EMULATOR_URL: "https://emulator.example",
    });
    expect(config.offlineReceive).toMatchObject({ enabled: true, registryUrls: undefined, emulatorUrl: "https://emulator.example" });
  });

  it("routes RFQs over HTTP only when told to, and only to a real URL", () => {
    const offline = {
      ...base,
      SOLVER_CARDS_FILE: "/cards.json",
      OFFLINE_EMULATOR_URL: "https://emulator.example",
      ARK_SERVER_URL: "https://ark.example",
    };
    expect(loadConfig(offline).offlineReceive.rfqHttpUrl).toBeUndefined();
    expect(loadConfig({ ...offline, SOLVER_RFQ_HTTP_URL: "http://localhost:8787" }).offlineReceive.rfqHttpUrl)
      .toBe("http://localhost:8787");
    expect(() => loadConfig({ ...offline, SOLVER_RFQ_HTTP_URL: "localhost:8787" })).toThrow(/SOLVER_RFQ_HTTP_URL/);
    // On its own it is still an offline-receive setting, so the usual wiring is demanded.
    expect(() => loadConfig({ ...base, SOLVER_RFQ_HTTP_URL: "http://localhost:8787" })).toThrow(/ARK_SERVER_URL/);
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
    ["MAX_SESSIONS", "0"],
    ["MAX_SESSIONS_PER_IP", "-1"],
    ["MAX_CONCURRENT_OFFLINE_QUOTES", "1.5"],
    ["CALLBACK_RATE_LIMIT_PER_MINUTE", "0"],
  ])("rejects invalid %s=%s", (name, value) => {
    expect(() => loadConfig({ ...base, [name]: value })).toThrow(name);
  });

  it("rejects a malformed emulator URL", () => {
    expect(() => loadConfig({ ...base, OFFLINE_EMULATOR_URL: "emulator.example" })).toThrow(/http\(s\)/);
  });

  it("rejects malformed registry and dependency URLs", () => {
    expect(() => loadConfig({ ...base, SOLVER_REGISTRY_URLS: "ftp://registry.example" })).toThrow(/SOLVER_REGISTRY_URLS/);
    expect(() => loadConfig({ ...base, ARK_SERVER_URL: "ark.example" })).toThrow(/ARK_SERVER_URL/);
  });

  it("reads the covenant-destination flag, and refuses a config nothing could sweep", () => {
    const withUrls = { ...base, ARK_SERVER_URL: "https://ark.example" };
    const on = loadConfig({
      ...withUrls,
      DB_PATH: "/data/x.db",
      ALLOW_INSECURE_TOKEN_STORAGE: "1",
      OFFLINE_COVENANT_DESTINATIONS: "true",
      OFFLINE_EMULATOR_URL: "https://emulator.example",
    });
    expect(on.offlineReceive.covenantDestinations).toBe(true);
    expect(on.offlineReceive.covenantRecoveryDelaySeconds).toBeUndefined();

    expect(loadConfig({ ...base }).offlineReceive.covenantDestinations).toBe(false);
    expect(
      loadConfig({ ...withUrls, OFFLINE_COVENANT_DESTINATIONS: "1" })
        .offlineReceive.covenantDestinations,
    ).toBe(false);

    // A payer must never be handed an address nothing can sweep, so the
    // emulator and the operator key are required up front.
    expect(() => loadConfig({ ...withUrls, OFFLINE_COVENANT_DESTINATIONS: "true" })).toThrow(/OFFLINE_EMULATOR_URL/);
    expect(() =>
      loadConfig({ ...base, OFFLINE_COVENANT_DESTINATIONS: "true", OFFLINE_EMULATOR_URL: "https://emulator.example" }),
    ).toThrow(/ARK_SERVER_URL/);
    const covenantOnly = loadConfig({
      ...base,
      DB_PATH: "/data/x.db",
      ALLOW_INSECURE_TOKEN_STORAGE: "1",
      ARK_SERVER_URL: "https://ark.example",
      OFFLINE_COVENANT_DESTINATIONS: "true",
      OFFLINE_EMULATOR_URL: "https://emulator.example",
    });
    expect(covenantOnly.offlineReceive.covenantDestinations).toBe(true);
    expect(covenantOnly.offlineReceive.enabled).toBe(false);
    expect(() => loadConfig({
      ...withUrls,
      OFFLINE_COVENANT_DESTINATIONS: "true",
      OFFLINE_EMULATOR_URL: "https://emulator.example",
    })).toThrow(/DB_PATH/);
    expect(() => loadConfig({
      ...withUrls,
      DB_PATH: ":memory:",
      ALLOW_INSECURE_TOKEN_STORAGE: "1",
      OFFLINE_COVENANT_DESTINATIONS: "true",
      OFFLINE_EMULATOR_URL: "https://emulator.example",
    })).toThrow(/file-backed DB_PATH/);
  });

  it("rejects a non-positive covenant recovery delay rather than building an unspendable leaf", () => {
    const withFlag = (v: string) => ({
      ...base,
      ARK_SERVER_URL: "https://ark.example",
      DB_PATH: "/data/x.db",
      ALLOW_INSECURE_TOKEN_STORAGE: "1",
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

  it.each([undefined, ""])("defers an unset recovery delay (%s) to arkd info", (recoveryDelay) => {
    const cfg = loadConfig({
      ...base,
      ARK_SERVER_URL: "https://ark.example",
      DB_PATH: "/data/x.db",
      ALLOW_INSECURE_TOKEN_STORAGE: "1",
      OFFLINE_COVENANT_DESTINATIONS: "true",
      OFFLINE_EMULATOR_URL: "https://emulator.example",
      OFFLINE_COVENANT_RECOVERY_DELAY_SECONDS: recoveryDelay,
    });
    expect(cfg.offlineReceive.covenantRecoveryDelaySeconds).toBeUndefined();
  });

});

describe("offline receive config", () => {
  const base = { NODE_ENV: "test", DB_PATH: "unused-test.sqlite", ALLOW_INSECURE_TOKEN_STORAGE: "1" } as Record<string, string>;

  // An emulator is also the covenant rail's co-signer, so it cannot on its own
  // mean "serve lightning swaps too" for a covenant-only deployment.
  it("does not switch the offline swap rail on for a covenant-only deployment", () => {
    const off = loadConfig({
      ...base,
      ARK_SERVER_URL: "https://ark.example",
      OFFLINE_EMULATOR_URL: "https://emulator.example",
      OFFLINE_COVENANT_DESTINATIONS: "true",
    }).offlineReceive;
    expect(off.covenantDestinations).toBe(true);
    expect(off.enabled).toBe(false);
  });

  it("stays off with no offline settings", () => {
    expect(loadConfig({ ...base }).offlineReceive.enabled).toBe(false);
  });
});
