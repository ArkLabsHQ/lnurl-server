import { createServer } from "./http/server.js";
import { loadConfig } from "./config.js";
import { VERSION } from "./version.js";
import { SessionManager } from "./services/sessions.js";
import type { Db } from "./db/connection.js";
import { pathToFileURL } from "node:url";
import { ConfigError, UpstreamError } from "./errors.js";

/** Ceiling on the dependency probes boot makes. Generous next to the in-request
 *  timeouts: a cold arkd is slower than a warm one, and failing here refuses to
 *  start rather than serving a degraded rail. */
const BOOT_PROBE_TIMEOUT_MS = 15_000;

/** Open + migrate + bootstrap the DB when configured; null in in-memory mode. */
export async function initPersistence(opts: {
  dbPath?: string;
  bootstrapDomain?: string;
  verifyTtlMs?: number;
}): Promise<Db | null> {
  if (!opts.dbPath) return null;
  const { openDb } = await import("./db/connection.js");
  const { runMigrations } = await import("./db/migrations.js");
  const { bootstrap } = await import("./bootstrap.js");
  const db = openDb(opts.dbPath);
  runMigrations(db, { legacySwapTtlMs: opts.verifyTtlMs });
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

  const db = await initPersistence({ dbPath: config.dbPath, bootstrapDomain: config.bootstrapDomain, verifyTtlMs: config.verifyTtlMs });
  if (config.offlineReceive.enabled && !db) throw new ConfigError("offline receive requires DB_PATH for durable accepted-swap recovery");
  const sessions = new SessionManager();
  runtime.addStop(() => sessions.shutdown("service shutdown"));
  if (db) {
    runtime.setDatabase(db);
    health.register("persistence", () => ({ ok: runtime.resources().dbOpen, detail: "SQLite open" }));
  }
  let deps: import("./http/server.js").ServerDeps | undefined;
  let solverDiscovery: import("./services/solver-discovery.js").DiscoveryService | undefined;

  if (db) {
    const { createRepositories } = await import("./db/repositories/index.js");
    const { AddressService } = await import("./services/addresses.js");
    const { RateLimiter } = await import("./rate-limit.js");
    const { SettingsService } = await import("./services/settings.js");
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
    const settlements = new DbSettlementStore(db, config.verifyTtlMs, undefined, config.destinationWatchMs);
    const off = config.offlineReceive;
    // One manager for both rails: the covenant rail spends through it, the swap rail
    // registers each lockup in it so funding arrives as an event.
    let contracts: import("@arkade-os/sdk").IContractManager | undefined;
    let contractEvents = true;
    if (off.covenantDestinations || off.enabled) {
      const { ContractManager, RestIndexerProvider, contractHandlers } = await import("@arkade-os/sdk");
      const { sqliteContractStores } = await import("./contract-store.js");
      if (off.covenantDestinations) {
        const { covenantDestinationHandler } = await import("./covenant/contract.js");
        // The SDK tracks, watches and spends these; registering the handler is what
        // lets it build the script and pick a leaf without us restating either. Must
        // precede create(), which re-adds every stored contract.
        contractHandlers.register(covenantDestinationHandler);
      }
      // Without a global EventSource every subscription throws and the SDK drops to a 20s
      // failsafe poll — correct, ~10x slower, and otherwise only visible as latency.
      try {
        (await import("@arkade-os/sdk")).resolveEventSource(undefined);
      } catch (error) {
        contractEvents = false;
        logger.warn("contract_events_unavailable", { error: (error as Error).message });
        console.warn(`WARNING: no EventSource — contract events are OFF, every watcher falls back to polling. Relaunch with --experimental-eventsource.`);
      }
      // Always SQLite: both rails need their contracts to survive a restart. In memory
      // the catch-up pass finds nothing, and a payment made while down never settles.
      const stores = await sqliteContractStores(db);
      try {
        contracts = await ContractManager.create({
          indexerProvider: new RestIndexerProvider(off.arkServerUrl!),
          ...stores,
        });
        runtime.addTransport({ close: () => contracts!.dispose() });
      } catch (error) {
        // Fatal for covenant destinations, which hand the payer an address only this
        // watches. The swap rail just loses its head start, so there it degrades.
        if (off.covenantDestinations) throw error;
        logger.warn("offline_lockup_watch_unavailable", { error });
      }
    }
    let offlineSwaps: import("./offline-swap-store.js").OfflineSwapStore | undefined;
    let arkDustSat: number | undefined;
    let arkNetwork: unknown;
    // Read for any rail arkd backs, not just the swap one: the arkade and covenant
    // rails face the same dust floor, and a covenant-only deployment never enters
    // the branch below. A dust change is an operator reconfiguring arkd rather
    // than something that moves under a running process, so once at boot is enough;
    // a missing value leaves the whole-sat floor in place.
    if (off.arkServerUrl) {
      // Bounded: an unreachable arkd that accepts the connection and never answers
      // would otherwise hang boot forever, with no listener and nothing in the log.
      const infoResponse = await fetch(`${off.arkServerUrl}/v1/info`, { signal: AbortSignal.timeout(BOOT_PROBE_TIMEOUT_MS) });
      if (!infoResponse.ok) throw new UpstreamError("Arkade info endpoint", infoResponse.status);
      const arkInfo = await infoResponse.json() as { network?: unknown; dust?: unknown };
      arkNetwork = arkInfo.network;
      const dust = Number(arkInfo.dust);
      if (Number.isSafeInteger(dust) && dust > 0) arkDustSat = dust;
    }
    let offlineSwapCreator: import("./services/offline-swaps.js").OfflineSwapCreator | undefined;
    if (off.enabled) {
      const { createOfflineSwapCoordinator } = await import("./services/offline-swaps.js");
      const { OfflineSwapStore } = await import("./offline-swap-store.js");
      const { DiscoveryService } = await import("./services/solver-discovery.js");
      const { isNetwork } = await import("@arkade-os/solver-discovery");
      const network = arkNetwork;
      if (!isNetwork(network)) throw new ConfigError(`Arkade info endpoint returned unsupported network ${String(network)}`);
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
      // Optional capability: no usable card keeps the interactive LNURL relay ready
      // while readiness still reports the outage and sessionless callbacks fail loudly.
      health.register("solverDiscovery", () => ({
        ok: discovery.status().ready,
        detail: discovery.status().ready ? `${discovery.status().candidateCount} candidate(s)` : discovery.status().reason,
      }), { required: false });
      if (!discovery.status().ready) logger.warn("offline_receive_unavailable", { reason: discovery.status().reason });
      const covclaimdProbe = off.covclaimdUrl
        ? await fetch(`${off.covclaimdUrl}/v1/preimage/covclaimd-pubkey`, { signal: AbortSignal.timeout(BOOT_PROBE_TIMEOUT_MS) })
        : null;
      if (covclaimdProbe && !covclaimdProbe.ok) throw new UpstreamError("covclaimd pubkey endpoint", covclaimdProbe.status);
      offlineSwaps = new OfflineSwapStore(db, config.verifyTtlMs);
      let selfClaimer: import("./covenant/self-claim.js").SelfClaimer | undefined;
      if (off.selfClaim) {
        const { createSelfClaimer, checkEmulatorPairing } = await import("./covenant/self-claim.js");
        selfClaimer = createSelfClaimer({ arkServerUrl: off.arkServerUrl!, emulatorUrl: off.emulatorUrl!, logger });
        console.log(`offline self-claim: enabled (emulator=${off.emulatorUrl}${off.covclaimdUrl ? "" : ", no covclaimd — RFQ omits the claim packet"})`);
        if (off.covclaimdUrl) {
          void checkEmulatorPairing({ covclaimdUrl: off.covclaimdUrl!, emulatorUrl: off.emulatorUrl! });
        }
      }
      const { httpTransport } = await import("@arkade-os/swap");
      offlineSwapCreator = await createOfflineSwapCoordinator({
        discovery,
        nostrSecretKey: off.nostrSecretKey,
        ...(off.rfqHttpUrl ? { transportFactory: () => httpTransport(off.rfqHttpUrl!) } : {}),
        ...(off.covclaimdUrl ? { covclaimdUrl: off.covclaimdUrl } : {}),
        ...(off.emulatorUrl ? { emulatorUrl: off.emulatorUrl } : {}),
        arkServerUrl: off.arkServerUrl!,
        stampClaimPacket: off.stampClaimPacket,
        ...(selfClaimer ? { selfClaimer } : {}),
        ...(contracts ? { contracts } : {}),
        logger,
      });
      if (offlineSwapCreator.close) runtime.addTransport({ close: offlineSwapCreator.close });
    }
    let covenantDestinations: import("./covenant/destination.js").CovenantDestinationProvider | undefined;
    if (off.covenantDestinations && contracts) {
      const { createCovenantDestinationProvider } = await import("./covenant/destination.js");
      covenantDestinations = createCovenantDestinationProvider({
        arkServerUrl: off.arkServerUrl!,
        ...(off.covclaimdUrl ? { covclaimdUrl: off.covclaimdUrl } : {}),
        ...(off.emulatorUrl ? { emulatorUrl: off.emulatorUrl } : {}),
        recoveryDelaySeconds: off.covenantRecoveryDelaySeconds,
        contracts,
      });
      // Event-driven, with the repeating catch-up behind it as the dropped-subscription
      // backstop OFFLINE_POLL_INTERVAL_MS is already documented to size.
      const { startCovenantWatcher } = await import("./workers/covenant-watcher.js");
      const { createCovenantSweeper, startCovenantSweeper } = await import("./workers/covenant-sweeper.js");
      // Built before the watcher so its trigger can be handed over: the event that
      // settles a covenant payment is the same event that makes it sweepable.
      const sweeper = startCovenantSweeper(
        createCovenantSweeper({ contracts, arkServerUrl: off.arkServerUrl!, emulatorUrl: off.emulatorUrl!, settlements }),
        15_000,
      );
      runtime.addStop(sweeper.stop);
      runtime.addStop(startCovenantWatcher(settlements, contracts, off.pollIntervalMs, sweeper.trigger));
      console.log(`covenant destinations: enabled (emulator=${off.emulatorUrl}, recovery=${off.covenantRecoveryDelaySeconds}s)`);
    }
    let watchDestination: ((destination: string) => void) | undefined;
    deps = {
      repos,
      addressService,
      registrationLimiter: new RateLimiter(() => settings.registrationRateLimitPerMin(), 60_000),
      sessions,
      settings,
      settlements,
      offlineSwapCreator,
      offlineSwaps,
      ...(solverDiscovery ? { solverDiscovery } : {}),
      ...(config.offlineReceive.arkServerUrl ? { arkServerUrl: config.offlineReceive.arkServerUrl } : {}),
      ...(arkDustSat ? { arkDustSat } : {}),
      onchainMinSat: config.onchainMinSendableSats,
      ...(covenantDestinations ? { covenantDestinations } : {}),
      // Late-bound: the watcher is built below, and nothing calls this until the
      // listeners are accepting, which is later still.
      onDestinationIssued: (destination) => watchDestination?.(destination),
    };
    // Every background scheduler registers its stop hook before the listeners
    // begin accepting traffic.
    if (offlineSwapCreator) {
      const { startOfflineSettlementPoller } = await import("./workers/offline-poller.js");
      const { startLockupWatcher } = await import("./workers/lockup-watcher.js");
      const poller = startOfflineSettlementPoller(settlements, offlineSwapCreator, off.pollIntervalMs, offlineSwaps, logger);
      runtime.addStop(poller.stop);
      if (contracts && offlineSwaps) runtime.addStop(startLockupWatcher(contracts, offlineSwaps, poller.trigger, logger));
      const via = `cards:${config.offlineReceive.registryUrls?.[0] ?? config.offlineReceive.cardsFile ?? "network-default"}`;
      const rfq = off.rfqHttpUrl ? `http:${off.rfqHttpUrl}` : "nostr";
      console.log(`offline receive: enabled (solver=${via}, rfq=${rfq}, claim=${contracts && contractEvents ? "event-driven" : "polled"})`);
    }
    // The destination rail (paymentOptions: arkade) settles by observation, not by
    // preimage: watch the indexer for payments to registered Arkade addresses.
    if (config.offlineReceive.arkServerUrl) {
      const { startArkadeWatcher } = await import("./workers/arkade-watcher.js");
      // Shares the contract manager's subscription: a second one loses the race
      // for arkd's stream and reports an EventSource error for the process's life.
      const arkadeWatcher = startArkadeWatcher(settlements, config.offlineReceive.arkServerUrl, 15_000, {
        ...(contracts ? { contracts } : {}),
      });
      runtime.addStop(arkadeWatcher.stop);
      watchDestination = arkadeWatcher.watch;
      console.log(`arkade watcher: enabled (indexer=${config.offlineReceive.arkServerUrl}, ${contracts && contractEvents ? "watched + 15s catch-up" : "15s catch-up only"})`);
    }
    console.log(`persistence: enabled at ${config.dbPath} (${deps.repos.domains.list().length} domain(s))`);

    const { createAdminServer } = await import("./http/admin-server.js");
    // Its own indexer client rather than a shared one: the reconcile route is an
    // operator-triggered read, and giving it the contract manager's would let a
    // support query contend with the watchers for the same connection.
    const adminIndexer = off.arkServerUrl
      ? new (await import("@arkade-os/sdk")).RestIndexerProvider(off.arkServerUrl)
      : undefined;
    const adminServer = createAdminServer({ repos, addressService, sessions, settings, config, settlements, discovery: solverDiscovery, ...(adminIndexer ? { indexer: adminIndexer } : {}), logger }).listen(config.adminPort, config.adminBind, () => {
      console.log(`admin server on http://${config.adminBind}:${config.adminPort} (front with a proxy)`);
    });
    runtime.addServer(adminServer);
  } else {
    console.log("persistence: disabled (in-memory mode)");
  }

  if (config.traceRequests) {
    const discovery = solverDiscovery?.status();
    logger.info("startup_config", {
      baseUrl: config.baseUrl,
      port: config.port,
      adminPort: config.adminPort,
      adminBind: config.adminBind,
      trustProxy: config.trustProxy,
      arkadeNetwork: discovery?.network,
      indexerUrl: config.offlineReceive.arkServerUrl,
      discoverySources: discovery?.sources.length,
      discoveryCandidates: discovery?.candidateCount,
      discoveryReady: discovery?.ready,
    });
  }

  const app = createServer(
    {
      port: config.port,
      baseUrl: config.baseUrl,
      minSendable: config.minSendable,
      maxSendable: config.maxSendable,
      invoiceTimeoutMs: config.invoiceTimeoutMs,
      verifyTtlMs: config.verifyTtlMs,
      // The store already honours it; without it here the advertised expiresAt
      // would quietly keep the default while the watcher used the override.
      destinationWatchMs: config.destinationWatchMs,
      trustProxy: config.trustProxy,
      traceRequests: config.traceRequests,
      maxSessions: config.maxSessions,
      maxSessionsPerIp: config.maxSessionsPerIp,
      maxConcurrentOfflineQuotes: config.maxConcurrentOfflineQuotes,
    },
    deps ? { ...deps, health, logger } : { health, logger } as never,
  );

  const publicServer = app.listen(config.port, () => {
    console.log(`arkade-lnurl listening on ${config.baseUrl} (v${VERSION})`);
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
    console.error(err instanceof ConfigError ? `config: ${err.message}` : err);
    process.exit(1);
  });
}
