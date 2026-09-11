/** Server-orchestrated offline receive over the Arkade intents corridor. */
export interface OfflineReceiveConfig {
  enabled: boolean;
  registryUrls: string[];
  cardsFile?: string;
  nostrSecretKey?: string;
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
  /** Push each lockup's covenant claim leaf ourselves instead of waiting for
   *  covclaimd to do it. Needs no key: the leaf is signed by the operator and the
   *  emulator, and gated on the preimage this server already holds. */
  selfClaim: boolean;
  /** Emulator base URL backing {@link selfClaim} — it co-signs the covenant leaf. */
  emulatorUrl?: string;
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
  maxSessions: number;
  maxSessionsPerIp: number;
  maxConcurrentOfflineQuotes: number;
  shutdownTimeoutMs: number;
  offlineReceive: OfflineReceiveConfig;
}

type Env = Record<string, string | undefined>;

const REMOVED_SOLVER_CONFIG = ["SOLVER_URL", "SOLVER_PUBKEY", "NOSTR_RELAYS", "SOLVER_REGISTRY_URL"] as const;

function integer(env: Env, name: string, fallback: number, opts: { min: number; max?: number }): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < opts.min || (opts.max !== undefined && value > opts.max)) {
    const range = opts.max === undefined ? `>= ${opts.min}` : `${opts.min}..${opts.max}`;
    throw new Error(`${name} must be an integer in ${range}`);
  }
  return value;
}

function httpUrl(raw: string, name: string): string {
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  if (!/^https?:$/.test(value.protocol) || value.username || value.password) {
    throw new Error(`${name} must be an absolute http(s) URL without credentials`);
  }
  return raw;
}

function csvHttpUrls(raw: string | undefined, name: string): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  return raw.split(",").map((entry) => httpUrl(entry.trim(), name));
}

function rejectRemovedSolverConfig(env: Env): void {
  for (const name of REMOVED_SOLVER_CONFIG) {
    if (env[name] !== undefined) throw new Error(`${name} has been removed; configure solver cards instead`);
  }
}

function parseKey(raw: string): Buffer {
  const buf = /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0 ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must decode to 32 bytes (hex or base64)");
  return buf;
}

export function loadConfig(env: Env = process.env): AppConfig {
  rejectRemovedSolverConfig(env);
  const port = integer(env, "PORT", 3000, { min: 1, max: 65_535 });
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

  const minSendable = integer(env, "MIN_SENDABLE", 1_000, { min: 1 });
  const maxSendable = integer(env, "MAX_SENDABLE", 100_000_000_000, { min: 1 });
  if (maxSendable < minSendable) throw new Error("MAX_SENDABLE must be greater than or equal to MIN_SENDABLE");
  const baseUrl = env.BASE_URL ? httpUrl(env.BASE_URL, "BASE_URL") : `http://localhost:${port}`;
  const adminPort = integer(env, "ADMIN_PORT", 3001, { min: 1, max: 65_535 });
  if (dbPath && adminPort === port) throw new Error("ADMIN_PORT must differ from PORT when DB_PATH is set");

  return {
    port,
    baseUrl,
    minSendable,
    maxSendable,
    invoiceTimeoutMs: integer(env, "INVOICE_TIMEOUT_MS", 30_000, { min: 1 }),
    verifyTtlMs: integer(env, "VERIFY_TTL_MS", 86_400_000, { min: 1 }),
    dbPath,
    adminPort,
    adminBind: env.ADMIN_BIND || "127.0.0.1",
    tokenEncryptionKey,
    allowInsecureTokenStorage,
    bootstrapDomain: env.BOOTSTRAP_DOMAIN || undefined,
    registrationRateLimitPerMin: integer(env, "REGISTRATION_RATE_LIMIT", 10, { min: 1 }),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    maxSessions: integer(env, "MAX_SESSIONS", 5_000, { min: 1 }),
    maxSessionsPerIp: integer(env, "MAX_SESSIONS_PER_IP", 50, { min: 1 }),
    maxConcurrentOfflineQuotes: integer(env, "MAX_CONCURRENT_OFFLINE_QUOTES", 20, { min: 1 }),
    shutdownTimeoutMs: integer(env, "SHUTDOWN_TIMEOUT_MS", 15_000, { min: 1 }),
    offlineReceive: buildOfflineReceive(env),
  };
}

function buildOfflineReceive(env: Env): OfflineReceiveConfig {
  const registryUrls = csvHttpUrls(env.SOLVER_REGISTRY_URLS, "SOLVER_REGISTRY_URLS");
  const cardsFile = env.SOLVER_CARDS_FILE?.trim() || undefined;
  const nostrSecretKey = env.NOSTR_SECRET_KEY || undefined;
  if (nostrSecretKey && !/^[0-9a-f]{64}$/i.test(nostrSecretKey)) {
    throw new Error("NOSTR_SECRET_KEY must be 64-char hex");
  }
  const covclaimdUrl = env.COVCLAIMD_URL ? httpUrl(env.COVCLAIMD_URL, "COVCLAIMD_URL") : undefined;
  const arkServerUrl = env.ARK_SERVER_URL ? httpUrl(env.ARK_SERVER_URL, "ARK_SERVER_URL") : undefined;
  const hasCards = registryUrls.length > 0 || cardsFile !== undefined;
  const selfClaim = env.OFFLINE_SELF_CLAIM === "true";
  const emulatorUrl = env.OFFLINE_EMULATOR_URL ? httpUrl(env.OFFLINE_EMULATOR_URL, "OFFLINE_EMULATOR_URL") : undefined;
  const stampClaimPacket = env.OFFLINE_STAMP_CLAIM_PACKET === "true";
  if (selfClaim && !emulatorUrl) {
    throw new Error("OFFLINE_SELF_CLAIM=true requires OFFLINE_EMULATOR_URL (the emulator co-signs the covenant claim)");
  }
  if (emulatorUrl && !selfClaim) throw new Error("OFFLINE_EMULATOR_URL requires OFFLINE_SELF_CLAIM=true");
  const anyOfflineSetting = hasCards || covclaimdUrl || arkServerUrl || nostrSecretKey || selfClaim || emulatorUrl || stampClaimPacket;
  if (anyOfflineSetting && (!hasCards || !covclaimdUrl || !arkServerUrl)) {
    throw new Error("offline receive requires solver cards, COVCLAIMD_URL, and ARK_SERVER_URL together");
  }
  return {
    enabled: Boolean(hasCards && covclaimdUrl && arkServerUrl),
    registryUrls,
    stampClaimPacket,
    selfClaim,
    ...(emulatorUrl ? { emulatorUrl } : {}),
    ...(cardsFile ? { cardsFile } : {}),
    ...(nostrSecretKey ? { nostrSecretKey } : {}),
    ...(covclaimdUrl ? { covclaimdUrl } : {}),
    ...(arkServerUrl ? { arkServerUrl } : {}),
  };
}

function parseTrustProxy(raw: string | undefined): number | boolean {
  if (raw === undefined || raw === "") return 1;
  if (raw === "false") return false;
  if (!/^\d+$/.test(raw)) throw new Error("TRUST_PROXY must be false or a non-negative integer");
  return Number(raw);
}
