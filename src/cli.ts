import { createServer } from "./server.js";
import { loadConfig } from "./config.js";
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
  let deps: import("./server.js").ServerDeps | undefined;
  if (db) {
    const { createRepositories } = await import("./db/repositories/index.js");
    const { AddressService } = await import("./address-service.js");
    const { RateLimiter } = await import("./rate-limit.js");
    const { hashSecret } = await import("./crypto.js");
    const repos = createRepositories(db);
    if (!config.tokenEncryptionKey) {
      console.warn("WARNING: ALLOW_INSECURE_TOKEN_STORAGE — using a static, source-readable encryption key. Do NOT use in production.");
    }
    const key = config.tokenEncryptionKey ?? hashSecret("INSECURE-DEV-KEY"); // effective key (insecure dev fallback)
    deps = {
      repos,
      addressService: new AddressService(repos, key),
      registrationLimiter: new RateLimiter(config.registrationRateLimitPerMin, 60_000),
    };
    console.log(`persistence: enabled at ${config.dbPath} (${deps.repos.domains.list().length} domain(s))`);
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
