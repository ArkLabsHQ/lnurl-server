import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const base = { PORT: "3000", BASE_URL: "http://localhost:3000" };

describe("loadConfig", () => {
  it("allows an explicit loopback bind without changing ordinary defaults", () => {
    expect(loadConfig(base).publicBind).toBeUndefined();
    expect(loadConfig({ ...base, PUBLIC_BIND: "127.0.0.1" }).publicBind).toBe("127.0.0.1");
  });

  it("refuses a non-IP public bind so startup cannot depend on host-controlled DNS", () => {
    expect(() => loadConfig({ ...base, PUBLIC_BIND: "localhost" })).toThrow(/PUBLIC_BIND/);
    expect(loadConfig({ ...base, PUBLIC_BIND: "::1" }).publicBind).toBe("::1");
  });

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

  it("reads VERIFY_TTL_MS with a 24h default", () => {
    expect(loadConfig({ ...base }).verifyTtlMs).toBe(86_400_000);
    expect(loadConfig({ ...base, VERIFY_TTL_MS: "1000" }).verifyTtlMs).toBe(1000);
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
      COVCLAIMD_URL: "https://covclaimd.example:7071",
      ARK_SERVER_URL: "https://mutinynet.arkade.sh",
    });
    expect(on.offlineReceive).toEqual({
      enabled: true,
      stampClaimPacket: false,
      selfClaim: false,
      covenantDestinations: false,
      covenantRecoveryDelaySeconds: 86_528,
      pollIntervalMs: 15_000,
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

    expect(() => loadConfig({ ...base, SOLVER_CARDS_FILE: "/cards.json" })).toThrow(/ARK_SERVER_URL/);
  });

  it("routes RFQs over HTTP only when told to, and only to a real URL", () => {
    const offline = {
      ...base,
      SOLVER_CARDS_FILE: "/cards.json",
      COVCLAIMD_URL: "https://covclaimd.example",
      ARK_SERVER_URL: "https://ark.example",
    };
    expect(loadConfig(offline).offlineReceive.rfqHttpUrl).toBeUndefined();
    expect(loadConfig({ ...offline, SOLVER_RFQ_HTTP_URL: "http://localhost:8787" }).offlineReceive.rfqHttpUrl)
      .toBe("http://localhost:8787");
    expect(() => loadConfig({ ...offline, SOLVER_RFQ_HTTP_URL: "localhost:8787" })).toThrow(/SOLVER_RFQ_HTTP_URL/);
    // On its own it is still an offline-receive setting, so the usual wiring is demanded.
    expect(() => loadConfig({ ...base, SOLVER_RFQ_HTTP_URL: "http://localhost:8787" })).toThrow(/ARK_SERVER_URL/);
  });

  it("allows persisted admin cards alongside the default registry", () => {
    const config = loadConfig({
      ...base,
      DB_PATH: "/data/lnurl.sqlite",
      ALLOW_INSECURE_TOKEN_STORAGE: "1",
      COVCLAIMD_URL: "https://covclaimd.example",
      ARK_SERVER_URL: "https://ark.example",
    });
    expect(config.offlineReceive).toMatchObject({ enabled: true, registryUrls: undefined });
  });

  it("leaves omitted registry URLs undefined so discovery follows the network default", () => {
    const config = loadConfig({
      ...base,
      COVCLAIMD_URL: "https://covclaimd.example",
      ARK_SERVER_URL: "https://ark.example",
    });

    expect(config.offlineReceive).toMatchObject({ enabled: true, registryUrls: undefined });
  });

  it("allows self-claim without COVCLAIMD_URL, omitting the claim packet", () => {
    const config = loadConfig({
      ...base,
      SOLVER_CARDS_FILE: "/cards.json",
      ARK_SERVER_URL: "https://ark.example",
      OFFLINE_SELF_CLAIM: "true",
      OFFLINE_EMULATOR_URL: "https://emulator.example",
    });
    expect(config.offlineReceive).toMatchObject({
      enabled: true,
      selfClaim: true,
      emulatorUrl: "https://emulator.example",
      arkServerUrl: "https://ark.example",
    });
    expect(config.offlineReceive).not.toHaveProperty("covclaimdUrl");

    // ...but stamping still names a covclaimd, so it still needs one.
    expect(() => loadConfig({
      ...base,
      SOLVER_CARDS_FILE: "/cards.json",
      ARK_SERVER_URL: "https://ark.example",
      OFFLINE_SELF_CLAIM: "true",
      OFFLINE_EMULATOR_URL: "https://emulator.example",
      OFFLINE_STAMP_CLAIM_PACKET: "true",
    })).toThrow(/COVCLAIMD_URL/);

    // ...and the operator URL is never optional: nothing derives without it.
    expect(() => loadConfig({
      ...base,
      SOLVER_CARDS_FILE: "/cards.json",
      OFFLINE_SELF_CLAIM: "true",
      OFFLINE_EMULATOR_URL: "https://emulator.example",
    })).toThrow(/ARK_SERVER_URL/);
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

  describe("enclave checkpoints", () => {
    it("does not change ordinary persistence by default", () => {
      expect(loadConfig(base).enclaveCheckpoint.enabled).toBe(false);
      expect(loadConfig(base).dbPath).toBeUndefined();
    });

    it("enables durable checkpoints with an explicit token and measured loopback defaults", () => {
      const cfg = loadConfig({ ...base, ENCLAVE_CHECKPOINT: "1", ENCLAVE_RUNTIME_TOKEN: "token", ALLOW_INSECURE_TOKEN_STORAGE: "1" });
      expect(cfg.dbPath).toBe("/run/lnurl/state.sqlite");
      expect(cfg.enclaveCheckpoint).toMatchObject({
        enabled: true,
        storageUrl: "http://127.0.0.1:7073",
        storageToken: "token",
        allowGenesis: false,
        checkpointIntervalMs: 5_000,
        checkpointKey: "lnurl/db",
      });
    });

    it("requires a token and an allowed genesis before a fresh head", () => {
      expect(() => loadConfig({ ...base, ENCLAVE_CHECKPOINT: "1", ALLOW_INSECURE_TOKEN_STORAGE: "1" })).toThrow(/ENCLAVE_RUNTIME_TOKEN/);
      expect(loadConfig({ ...base, ENCLAVE_CHECKPOINT: "1", ENCLAVE_RUNTIME_TOKEN: "token", ENCLAVE_CHECKPOINT_ALLOW_GENESIS: "1", ALLOW_INSECURE_TOKEN_STORAGE: "1" })
        .enclaveCheckpoint.allowGenesis).toBe(true);
      expect(loadConfig({ ...base, ENCLAVE_CHECKPOINT: "true", ENCLAVE_RUNTIME_TOKEN: "token", ALLOW_INSECURE_TOKEN_STORAGE: "1" }).enclaveCheckpoint.enabled).toBe(false);
    });

    it("supports a deploy-time runtime URL and bounded checkpoint cadence", () => {
      const cfg = loadConfig({
        ...base,
        ENCLAVE_CHECKPOINT: "1",
        ENCLAVE_RUNTIME_TOKEN: "token",
        ALLOW_INSECURE_TOKEN_STORAGE: "1",
        ENCLAVE_STORAGE_URL: "https://127.0.0.1:7073",
        ENCLAVE_CHECKPOINT_INTERVAL_MS: "250",
        ENCLAVE_CHECKPOINT_KEY: "tenant-a/db",
      });
      expect(cfg.enclaveCheckpoint.storageUrl).toBe("https://127.0.0.1:7073");
      expect(cfg.enclaveCheckpoint.checkpointIntervalMs).toBe(250);
      expect(cfg.enclaveCheckpoint.checkpointKey).toBe("tenant-a/db");
      expect(() => loadConfig({ ...base, ENCLAVE_CHECKPOINT: "1", ENCLAVE_RUNTIME_TOKEN: "token", ALLOW_INSECURE_TOKEN_STORAGE: "1", ENCLAVE_CHECKPOINT_INTERVAL_MS: "99" }))
        .toThrow(/ENCLAVE_CHECKPOINT_INTERVAL_MS/);
    });

    it("pins a head, and refuses one that contradicts the genesis opt-in", () => {
      const pinned = "ab".repeat(32);
      const on = { ...base, ENCLAVE_CHECKPOINT: "1", ENCLAVE_RUNTIME_TOKEN: "token", ALLOW_INSECURE_TOKEN_STORAGE: "1" };
      expect(loadConfig({ ...on, ENCLAVE_CHECKPOINT_HEAD: pinned }).enclaveCheckpoint.expectedHead).toBe(pinned);
      expect(() => loadConfig({ ...on, ENCLAVE_CHECKPOINT_HEAD: "AB".repeat(32) })).toThrow(/ENCLAVE_CHECKPOINT_HEAD/);
      expect(() => loadConfig({ ...on, ENCLAVE_CHECKPOINT_HEAD: pinned, ENCLAVE_CHECKPOINT_ALLOW_GENESIS: "1" })).toThrow(/contradict/);
    });

    it("rejects a malformed runtime URL or checkpoint key", () => {
      expect(() => loadConfig({ ...base, ENCLAVE_CHECKPOINT: "1", ENCLAVE_RUNTIME_TOKEN: "token", ALLOW_INSECURE_TOKEN_STORAGE: "1", ENCLAVE_CHECKPOINT_KEY: "../bad" })).toThrow(/ENCLAVE_CHECKPOINT_KEY/);
      expect(() => loadConfig({ ...base, ENCLAVE_CHECKPOINT: "1", ENCLAVE_RUNTIME_TOKEN: "token", ALLOW_INSECURE_TOKEN_STORAGE: "1", ENCLAVE_STORAGE_URL: "run.invalid" }))
        .toThrow(/ENCLAVE_STORAGE_URL/);
    });
  });

  it("rejects malformed registry and dependency URLs", () => {
    expect(() => loadConfig({ ...base, SOLVER_REGISTRY_URLS: "ftp://registry.example" })).toThrow(/SOLVER_REGISTRY_URLS/);
    expect(() => loadConfig({ ...base, COVCLAIMD_URL: "covclaimd.example" })).toThrow(/COVCLAIMD_URL/);
  });

  it("reads the covenant-destination flag, and refuses a config nothing could sweep", () => {
    const withUrls = { ...base, COVCLAIMD_URL: "https://cc.example", ARK_SERVER_URL: "https://ark.example" };
    const on = loadConfig({
      ...withUrls,
      DB_PATH: "/data/x.db",
      ALLOW_INSECURE_TOKEN_STORAGE: "1",
      OFFLINE_COVENANT_DESTINATIONS: "true",
      OFFLINE_EMULATOR_URL: "https://emulator.example",
    });
    expect(on.offlineReceive.covenantDestinations).toBe(true);
    expect(on.offlineReceive.covenantRecoveryDelaySeconds).toBe(86_528);

    expect(loadConfig({ ...base }).offlineReceive.covenantDestinations).toBe(false);
    expect(
      loadConfig({ ...withUrls, OFFLINE_COVENANT_DESTINATIONS: "1" })
        .offlineReceive.covenantDestinations,
    ).toBe(false);

    // A payer must never be handed an address nothing can sweep, so the
    // emulator and the operator key are required up front. Covclaimd is not:
    // the arkade rail never touches it.
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
      COVCLAIMD_URL: "https://cc.example",
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

  it("ships a default recovery delay BIP68 can actually encode", () => {
    const cfg = loadConfig({
      ...base,
      COVCLAIMD_URL: "https://cc.example",
      ARK_SERVER_URL: "https://ark.example",
      DB_PATH: "/data/x.db",
      ALLOW_INSECURE_TOKEN_STORAGE: "1",
      OFFLINE_COVENANT_DESTINATIONS: "true",
      OFFLINE_EMULATOR_URL: "https://emulator.example",
    });
    expect(cfg.offlineReceive.covenantRecoveryDelaySeconds % 512).toBe(0);
  });

});

describe("self-claim is the default where it can run", () => {
  const base = { NODE_ENV: "test", DB_PATH: "unused-test.sqlite", ALLOW_INSECURE_TOKEN_STORAGE: "1" } as Record<string, string>;
  const swapRail = {
    ...base,
    SOLVER_CARDS_FILE: "/cards.json",
    ARK_SERVER_URL: "https://ark.example",
    OFFLINE_EMULATOR_URL: "https://emulator.example",
  };

  // covclaimd is not this service's claimer: the server generates the preimage,
  // so it can push the covenant leaf itself. A deployment able to do that should
  // not be waiting on a third party to decide whether a receive settles.
  it("claims for itself when an emulator is configured", () => {
    expect(loadConfig(swapRail).offlineReceive.selfClaim).toBe(true);
  });

  it("no longer forces COVCLAIMD_URL to make the offline rail legal", () => {
    const off = loadConfig(swapRail).offlineReceive;
    expect(off.enabled).toBe(true);
    expect(off.covclaimdUrl).toBeUndefined();
  });

  // The deliberate covclaimd-only deployment. No emulator either: opting out of
  // self-claim leaves nothing else on this rail using one, and a URL nothing
  // consumes is already refused elsewhere.
  it("still takes an explicit opt-out", () => {
    const off = loadConfig({
      ...base,
      SOLVER_CARDS_FILE: "/cards.json",
      ARK_SERVER_URL: "https://ark.example",
      COVCLAIMD_URL: "https://cc.example",
      OFFLINE_SELF_CLAIM: "false",
    }).offlineReceive;
    expect(off.selfClaim).toBe(false);
    expect(off.enabled).toBe(true);
  });

  // The emulator co-signs the leaf, so asking without one is a misconfiguration
  // rather than something to quietly downgrade.
  it("still refuses an explicit opt-in with no emulator", () => {
    expect(() => loadConfig({ ...base, SOLVER_CARDS_FILE: "/cards.json", ARK_SERVER_URL: "https://ark.example", OFFLINE_SELF_CLAIM: "true" }))
      .toThrow(/requires OFFLINE_EMULATOR_URL/);
  });

  // The regression this default used to cause: an emulator is also the covenant
  // rail's co-signer, so it cannot on its own mean "serve lightning swaps too".
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

  it("stays off where there is no emulator to co-sign with", () => {
    expect(loadConfig({ ...base }).offlineReceive.selfClaim).toBe(false);
  });
});
