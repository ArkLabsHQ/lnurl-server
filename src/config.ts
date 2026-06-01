export interface AppConfig {
  port: number;
  baseUrl: string;
  minSendable: number;
  maxSendable: number;
  invoiceTimeoutMs: number;
  dbPath?: string;
  adminPort: number;
  adminBind: string;
  tokenEncryptionKey?: Buffer;
  allowInsecureTokenStorage: boolean;
  bootstrapDomain?: string;
  registrationRateLimitPerMin: number;
  trustProxy: boolean;
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
    dbPath,
    adminPort: Number(env.ADMIN_PORT) || 3001,
    adminBind: env.ADMIN_BIND || "127.0.0.1",
    tokenEncryptionKey,
    allowInsecureTokenStorage,
    bootstrapDomain: env.BOOTSTRAP_DOMAIN || undefined,
    registrationRateLimitPerMin: Number(env.REGISTRATION_RATE_LIMIT) || 10,
    trustProxy: env.TRUST_PROXY !== "false",
  };
}
