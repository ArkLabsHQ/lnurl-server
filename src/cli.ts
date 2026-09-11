import { createServer } from "./server.js";
import { loadConfig } from "./config.js";
import { SessionManager } from "./session-manager.js";
import type { Db } from "./db/connection.js";
import { pathToFileURL } from "node:url";

/** Open + migrate + bootstrap the DB when configured; null in in-memory mode. */
export async function initPersistence(opts: {
  dbPath?: string;
  bootstrapDomain?: string;
}): Promise<Db | null> {
  if (!opts.dbPath) return null;
  const { openDb } = await import("./db/connection.js");
  const { runMigrations } = await import("./db/migrations.js");
  const { bootstrap } = await import("./bootstrap.js");
  const db = openDb(opts.dbPath);
  runMigrations(db);
  bootstrap(db, { bootstrapDomain: opts.bootstrapDomain });
  return db;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { HealthRegistry } = await import("./health.js");
  const { createRuntime } = await import("./runtime.js");
  const { createLogger } = await import("./logger.js");
  const health = new HealthRegistry();
  const runtime = createRuntime(health, config.shutdownTimeoutMs);
  const logger = createLogger();

  const db = await initPersistence({ dbPath: config.dbPath, bootstrapDomain: config.bootstrapDomain });
  if (config.offlineReceive.enabled && !db) throw new Error("offline receive requires DB_PATH for durable accepted-swap recovery");
  const sessions = new SessionManager();
  runtime.addStop(() => sessions.shutdown("service shutdown"));
  if (db) {
    runtime.setDatabase(db);
    health.register("persistence", () => ({ ok: runtime.resources().dbOpen, detail: "SQLite open" }));
  }
  let deps: import("./server.js").ServerDeps | undefined;

  if (db) {
    const { createRepositories } = await import("./db/repositories/index.js");
    const { AddressService } = await import("./address-service.js");
    const { RateLimiter } = await import("./rate-limit.js");
    const { SettingsService } = await import("./settings.js");
    const { hashSecret } = await import("./crypto.js");
    const { DbSettlementStore } = await import("./settlement-store.js");
    const repos = createRepositories(db);
    if (!config.tokenEncryptionKey) {
      console.warn("WARNING: ALLOW_INSECURE_TOKEN_STORAGE — using a static, source-readable encryption key. Do NOT use in production.");
    }
    const key = config.tokenEncryptionKey ?? hashSecret("INSECURE-DEV-KEY"); // effective key (insecure dev fallback)
    const addressService = new AddressService(repos, key);
    const settings = new SettingsService(repos.settings, {
      minSendable: config.minSendable,
      maxSendable: config.maxSendable,
      invoiceTimeoutMs: config.invoiceTimeoutMs,
      baseUrl: config.baseUrl,
      registrationRateLimitPerMin: config.registrationRateLimitPerMin,
    });
    const settlements = new DbSettlementStore(db, config.verifyTtlMs);
    let offlineSwaps: import("./offline-swap-store.js").OfflineSwapStore | undefined;
    let offlineSwapCreator: import("./intent-swap.js").OfflineSwapCreator | undefined;
    let solverDiscovery: import("./solver-discovery.js").DiscoveryService | undefined;
    if (config.offlineReceive.enabled) {
      const { createOfflineSwapCoordinator } = await import("./intent-swap.js");
      const { OfflineSwapStore } = await import("./offline-swap-store.js");
      const { DiscoveryService } = await import("./solver-discovery.js");
      const { isNetwork } = await import("@arkade-os/solver-discovery");
      const off = config.offlineReceive;
      const infoResponse = await fetch(`${off.arkServerUrl}/v1/info`);
      if (!infoResponse.ok) throw new Error(`Arkade info endpoint: HTTP ${infoResponse.status}`);
      const network = (await infoResponse.json() as { network?: unknown }).network;
      if (!isNetwork(network)) throw new Error(`Arkade info endpoint returned unsupported network ${String(network)}`);
      const discovery = new DiscoveryService({
        network,
        registryUrls: off.registryUrls,
        cardsFile: off.cardsFile,
        cardStore: repos.solverCards,
        cacheStore: repos.solverRegistryCache,
      });
      await discovery.start();
      runtime.addStop(() => discovery.stop());
      solverDiscovery = discovery;
      health.register("solverDiscovery", () => ({
        ok: discovery.status().ready,
        detail: discovery.status().ready ? `${discovery.status().candidateCount} candidate(s)` : discovery.status().reason,
      }));
      const covclaimdProbe = await fetch(`${off.covclaimdUrl}/v1/preimage/covclaimd-pubkey`);
      if (!covclaimdProbe.ok) throw new Error(`covclaimd pubkey endpoint: HTTP ${covclaimdProbe.status}`);
      offlineSwaps = new OfflineSwapStore(db, config.verifyTtlMs);
      let selfClaimer: import("./self-claim.js").SelfClaimer | undefined;
      if (off.selfClaim) {
        const { createSelfClaimer, checkEmulatorPairing } = await import("./self-claim.js");
        selfClaimer = createSelfClaimer({ arkServerUrl: off.arkServerUrl!, emulatorUrl: off.emulatorUrl! });
        console.log(`offline self-claim: enabled (emulator=${off.emulatorUrl})`);
        void checkEmulatorPairing({ covclaimdUrl: off.covclaimdUrl!, emulatorUrl: off.emulatorUrl! });
      }
      offlineSwapCreator = await createOfflineSwapCoordinator({
        discovery,
        nostrSecretKey: off.nostrSecretKey,
        covclaimdUrl: off.covclaimdUrl!,
        arkServerUrl: off.arkServerUrl!,
        stampClaimPacket: off.stampClaimPacket,
        ...(selfClaimer ? { selfClaimer } : {}),
      });
      if (offlineSwapCreator.close) runtime.addTransport({ close: offlineSwapCreator.close });
    }
    deps = {
      repos,
      addressService,
      registrationLimiter: new RateLimiter(() => settings.registrationRateLimitPerMin(), 60_000),
      sessions,
      settings,
      settlements,
      offlineSwapCreator,
      offlineSwaps,
    };
    // Neither timer below keeps its stop function: both are unref'd, and there is
    // no process-shutdown hook for either to be called from.
    if (offlineSwapCreator) {
      const { startOfflineSettlementPoller } = await import("./offline-poller.js");
      runtime.addStop(startOfflineSettlementPoller(settlements, offlineSwapCreator, 15_000, offlineSwaps));
      const via = `cards:${config.offlineReceive.registryUrls[0] ?? config.offlineReceive.cardsFile}`;
      console.log(`offline receive: enabled (solver=${via})`);
    }
    // The destination rail (paymentOptions: arkade) settles by observation, not by
    // preimage: watch the indexer for payments to registered Arkade addresses.
    if (config.offlineReceive.arkServerUrl) {
      const { startArkadeWatcher } = await import("./arkade-watcher.js");
      runtime.addStop(startArkadeWatcher(settlements, config.offlineReceive.arkServerUrl, 15_000));
      console.log(`arkade watcher: enabled (indexer=${config.offlineReceive.arkServerUrl})`);
    }
    console.log(`persistence: enabled at ${config.dbPath} (${deps.repos.domains.list().length} domain(s))`);

    const { createAdminServer } = await import("./admin-server.js");
    const adminServer = createAdminServer({ repos, addressService, sessions, settings, config, settlements, discovery: solverDiscovery }).listen(config.adminPort, config.adminBind, () => {
      console.log(`admin server on http://${config.adminBind}:${config.adminPort} (front with a proxy)`);
    });
    runtime.addServer(adminServer);
  } else {
    console.log("persistence: disabled (in-memory mode)");
  }

  const app = createServer(
    {
      port: config.port,
      baseUrl: config.baseUrl,
      minSendable: config.minSendable,
      maxSendable: config.maxSendable,
      invoiceTimeoutMs: config.invoiceTimeoutMs,
      verifyTtlMs: config.verifyTtlMs,
      trustProxy: config.trustProxy,
      maxSessions: config.maxSessions,
      maxSessionsPerIp: config.maxSessionsPerIp,
      maxConcurrentOfflineQuotes: config.maxConcurrentOfflineQuotes,
    },
    deps ? { ...deps, health, logger } : { health, logger } as never,
  );

  const publicServer = app.listen(config.port, () => {
    console.log(`arkade-lnurl listening on ${config.baseUrl}`);
    console.log(`  min: ${config.minSendable} msat, max: ${config.maxSendable} msat`);
    console.log(`  invoice timeout: ${config.invoiceTimeoutMs}ms`);
  });
  runtime.addServer(publicServer);

  let signals = 0;
  const shutdown = (signal: string) => {
    if (++signals > 1) process.exit(1);
    void runtime.shutdown(signal).then(() => process.exit(0), (error) => {
      logger.error("shutdown_failed", { signal, error });
      process.exit(1);
    });
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
