/** Server-orchestrated offline receive over the Arkade intents corridor
 *  (`lightning:BTC -> arkade:BTC` solver quote + covclaimd claim).
 *  Enabled when COVCLAIMD_URL + ARK_SERVER_URL are set and a solver transport is
 *  configured: SOLVER_URL (HTTP, dev/custom), SOLVER_PUBKEY + NOSTR_RELAYS (Nostr,
 *  the production transport), or SOLVER_REGISTRY_URL (discover from a registry index). */
export interface OfflineReceiveConfig {
  enabled: boolean;
  solverUrl?: string;
  solverPubkey?: string;
  nostrRelays?: string[];
  nostrSecretKey?: string;
  registryUrl?: string;
  covclaimdUrl?: string;
  arkServerUrl?: string;
  /**
   * Send the claim packet for the solver to stamp into the funding tx, rather
   * than the bare ciphertext it reveals to its own covclaimd.
   *
   * Off by default because it is not safe against a solver that predates
   * arkade-os/intent-solver#47: that one forwards the packet as a ciphertext,
   * covclaimd cannot decrypt it, and the swap funds and refunds. Turning it on
   * is a statement about the solver being quoted, so it cannot be inferred here.
   */
  stampClaimPacket: boolean;
}

export interface AppConfig {
  port: number;
  baseUrl: string;
  minSendable: number;
  maxSendable: number;
  invoiceTimeoutMs: number;
  verifyTtlMs: number;
  dbPath?: string;
  adminPort: number;
  adminBind: string;
  tokenEncryptionKey?: Buffer;
  allowInsecureTokenStorage: boolean;
  bootstrapDomain?: string;
  registrationRateLimitPerMin: number;
  trustProxy: number | boolean;
  offlineReceive: OfflineReceiveConfig;
}

type Env = Record<string, string | undefined>;

function parseKey(raw: string): Buffer {
  const buf = /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0 ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must decode to 32 bytes (hex or base64)");
  return buf;
}

export function loadConfig(env: Env = process.env): AppConfig {
  const port = Number(env.PORT) || 3000;
  const dbPath = env.DB_PATH || undefined;
  const allowInsecureTokenStorage = env.ALLOW_INSECURE_TOKEN_STORAGE === "1";

  let tokenEncryptionKey: Buffer | undefined;
  if (env.TOKEN_ENCRYPTION_KEY) {
    tokenEncryptionKey = parseKey(env.TOKEN_ENCRYPTION_KEY);
  }
  if (dbPath && !tokenEncryptionKey && !allowInsecureTokenStorage) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is required when DB_PATH is set (or set ALLOW_INSECURE_TOKEN_STORAGE=1 for dev)",
    );
  }

  return {
    port,
    baseUrl: env.BASE_URL || `http://localhost:${port}`,
    minSendable: Number(env.MIN_SENDABLE) || 1_000,
    maxSendable: Number(env.MAX_SENDABLE) || 100_000_000_000,
    invoiceTimeoutMs: Number(env.INVOICE_TIMEOUT_MS) || 30_000,
    verifyTtlMs: Number(env.VERIFY_TTL_MS) || 86_400_000,
    dbPath,
    adminPort: Number(env.ADMIN_PORT) || 3001,
    adminBind: env.ADMIN_BIND || "127.0.0.1",
    tokenEncryptionKey,
    allowInsecureTokenStorage,
    bootstrapDomain: env.BOOTSTRAP_DOMAIN || undefined,
    registrationRateLimitPerMin: Number(env.REGISTRATION_RATE_LIMIT) || 10,
    trustProxy: /^\d+$/.test(env.TRUST_PROXY ?? "") ? Number(env.TRUST_PROXY) : env.TRUST_PROXY === "false" ? false : 1,
    offlineReceive: buildOfflineReceive(env),
  };
}

function buildOfflineReceive(env: Env): OfflineReceiveConfig {
  const solverUrl = env.SOLVER_URL || undefined;
  const solverPubkey = env.SOLVER_PUBKEY || undefined;
  const nostrRelays = env.NOSTR_RELAYS?.split(",").map((r) => r.trim()).filter(Boolean);
  // ws:// is valid (regtest/dev relays terminate no TLS); anything else fails at
  // startup rather than as a runtime connection error.
  for (const r of nostrRelays ?? []) {
    if (!/^wss?:\/\//.test(r)) throw new Error(`NOSTR_RELAYS entries must be ws(s):// URLs (got "${r}")`);
  }
  const nostrSecretKey = env.NOSTR_SECRET_KEY || undefined;
  const registryUrl = env.SOLVER_REGISTRY_URL || undefined;
  const covclaimdUrl = env.COVCLAIMD_URL || undefined;
  const arkServerUrl = env.ARK_SERVER_URL || undefined;
  const hasTransport = Boolean(solverUrl || (solverPubkey && nostrRelays?.length) || registryUrl);
  return {
    enabled: Boolean(hasTransport && covclaimdUrl && arkServerUrl),
    stampClaimPacket: env.OFFLINE_STAMP_CLAIM_PACKET === "true",
    ...(solverUrl ? { solverUrl } : {}),
    ...(solverPubkey ? { solverPubkey } : {}),
    ...(nostrRelays?.length ? { nostrRelays } : {}),
    ...(nostrSecretKey ? { nostrSecretKey } : {}),
    ...(registryUrl ? { registryUrl } : {}),
    ...(covclaimdUrl ? { covclaimdUrl } : {}),
    ...(arkServerUrl ? { arkServerUrl } : {}),
  };
}
