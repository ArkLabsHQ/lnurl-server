import { createServer } from "./server.js";
import { loadConfig } from "./config.js";
import { SessionManager } from "./session-manager.js";
import type { Db } from "./db/connection.js";

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

  const db = await initPersistence({ dbPath: config.dbPath, bootstrapDomain: config.bootstrapDomain });
  const sessions = new SessionManager();
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
    let offlineSwapCreator: import("./intent-swap.js").OfflineSwapCreator | undefined;
    if (config.offlineReceive.enabled) {
      const { createIntentSwapCreator } = await import("./intent-swap.js");
      const off = config.offlineReceive;
      offlineSwapCreator = createIntentSwapCreator({
        solverUrl: off.solverUrl,
        solverPubkey: off.solverPubkey,
        nostrRelays: off.nostrRelays,
        nostrSecretKey: off.nostrSecretKey,
        covclaimdUrl: off.covclaimdUrl!,
        arkServerUrl: off.arkServerUrl!,
      });
    }
    deps = {
      repos,
      addressService,
      registrationLimiter: new RateLimiter(() => settings.registrationRateLimitPerMin(), 60_000),
      sessions,
      settings,
      settlements,
      offlineSwapCreator,
    };
    if (offlineSwapCreator) {
      const { startOfflineSettlementPoller } = await import("./offline-poller.js");
      startOfflineSettlementPoller(settlements, offlineSwapCreator, 15_000);
      const via = config.offlineReceive.solverUrl ?? `nostr:${config.offlineReceive.solverPubkey}`;
      console.log(`offline receive: enabled (solver=${via})`);
    }
    console.log(`persistence: enabled at ${config.dbPath} (${deps.repos.domains.list().length} domain(s))`);

    const { createAdminServer } = await import("./admin-server.js");
    createAdminServer({ repos, addressService, sessions, settings, config }).listen(config.adminPort, config.adminBind, () => {
      console.log(`admin server on http://${config.adminBind}:${config.adminPort} (front with a proxy)`);
    });
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
    },
    deps,
  );

  app.listen(config.port, () => {
    console.log(`arkade-lnurl listening on ${config.baseUrl}`);
    console.log(`  min: ${config.minSendable} msat, max: ${config.maxSendable} msat`);
    console.log(`  invoice timeout: ${config.invoiceTimeoutMs}ms`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
