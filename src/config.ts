import { ConfigError } from "./errors.js";
import { ffAuth, type FfAuth } from "./rails/fixedfloat/client.js";
import { FF_ASSETS } from "./rails/fixedfloat/catalogue.js";

/** Token deposits through FixedFloat, or through the simulator off mainnet. */
export interface FixedFloatConfig {
  mode: "live" | "simulate";
  /** The signer, closed over the key and secret so neither is a field of any config object. */
  auth?: FfAuth;
  refcode?: string;
  afftax?: number;
  /** FixedFloat codes; absent means the whole asset table. */
  allow?: string[];
  deny: string[];
  baseUrl: string;
  ratesUrl: string;
  /** Deposit window assumed before an order exists; each order's own deadline is checked too. */
  windowSeconds: number;
  /** What FixedFloat may need between a deposit and paying the invoice. */
  settleMarginSeconds: number;
  refreshMs: number;
  maxOpenOrders: number;
}

/** Server-orchestrated offline receive over the Arkade intents corridor. */
export interface OfflineReceiveConfig {
  enabled: boolean;
  registryUrls?: string[];
  cardsFile?: string;
  nostrSecretKey?: string;
  covclaimdUrl?: string;
  arkServerUrl?: string;
  /** Put RFQs to the solver's HTTP ingress instead of the nostr relay its card
   *  advertises. A solver listens on one or the other, never both: the regtest
   *  stack's runs `serve`, so over nostr it looks unreachable, not misaddressed. */
  rfqHttpUrl?: string;
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
   *  emulator, and gated on the preimage this server already holds. With
   *  {@link emulatorUrl} set, COVCLAIMD_URL may be omitted: the RFQ omits the
   *  claim packet and the solver waits for this claim. */
  selfClaim: boolean;
  /** Emulator base URL backing {@link selfClaim} — it co-signs the covenant leaf. */
  emulatorUrl?: string;
  /** Give each arkade-rail payment its own covenant address instead of the user's
   *  static one, so concurrent payments are told apart by script rather than by
   *  amount and arrival window. Needs {@link emulatorUrl} for the sweep. */
  covenantDestinations: boolean;
  /** CSV delay, seconds, before the user may sweep a covenant destination alone. */
  covenantRecoveryDelaySeconds: number;
  /** Settlement-pass interval, ms. Not what claims a lockup — src/workers/lockup-watcher.ts
   *  does that on the funding event — so what is left on it is the backstop for a
   *  dropped subscription and the solver status check the RFQ transport cannot push. */
  pollIntervalMs: number;
}

export interface AppConfig {
  port: number;
  baseUrl: string;
  minSendable: number;
  maxSendable: number;
  /** Economic floor for the onchain rail, sats. @see ONCHAIN_MIN_SENDABLE_SATS */
  onchainMinSendableSats: number;
  invoiceTimeoutMs: number;
  verifyTtlMs: number;
  /** How long a handed-out destination stays watched. Separate from verifyTtlMs
   *  because a hold invoice expires and a destination does not. */
  destinationWatchMs: number;
  dbPath?: string;
  adminPort: number;
  adminBind: string;
  tokenEncryptionKey?: Buffer;
  allowInsecureTokenStorage: boolean;
  bootstrapDomain?: string;
  registrationRateLimitPerMin: number;
  trustProxy: number | boolean;
  traceRequests: boolean;
  maxSessions: number;
  maxSessionsPerIp: number;
  maxConcurrentOfflineQuotes: number;
  shutdownTimeoutMs: number;
  offlineReceive: OfflineReceiveConfig;
  fixedFloat?: FixedFloatConfig;
}

type Env = Record<string, string | undefined>;

const REMOVED_SOLVER_CONFIG = ["SOLVER_URL", "SOLVER_PUBKEY", "NOSTR_RELAYS", "SOLVER_REGISTRY_URL"] as const;

function integer(env: Env, name: string, fallback: number, opts: { min: number; max?: number }): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < opts.min || (opts.max !== undefined && value > opts.max)) {
    const range = opts.max === undefined ? `>= ${opts.min}` : `${opts.min}..${opts.max}`;
    throw new ConfigError(`${name} must be an integer in ${range}`);
  }
  return value;
}

function httpUrl(raw: string, name: string): string {
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw new ConfigError(`${name} must be an absolute http(s) URL`);
  }
  if (!/^https?:$/.test(value.protocol) || value.username || value.password) {
    throw new ConfigError(`${name} must be an absolute http(s) URL without credentials`);
  }
  return raw;
}

function csvHttpUrls(raw: string | undefined, name: string): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  return raw.split(",").map((entry) => httpUrl(entry.trim(), name));
}

function rejectRemovedSolverConfig(env: Env): void {
  for (const name of REMOVED_SOLVER_CONFIG) {
    if (env[name] !== undefined) throw new ConfigError(`${name} has been removed; configure solver cards instead`);
  }
}

function parseKey(raw: string): Buffer {
  const buf = /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0 ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new ConfigError("TOKEN_ENCRYPTION_KEY must decode to 32 bytes (hex or base64)");
  return buf;
}

export function loadConfig(env: Env = process.env): AppConfig {
  rejectRemovedSolverConfig(env);
  const port = integer(env, "PORT", 3000, { min: 1, max: 65_535 });
  const dbPath = env.DB_PATH || undefined;
  const allowInsecureTokenStorage = env.ALLOW_INSECURE_TOKEN_STORAGE === "1";
  const traceRequests = env.TRACE_REQUESTS === "1";
  const offlineReceive = buildOfflineReceive(env);

  let tokenEncryptionKey: Buffer | undefined;
  if (env.TOKEN_ENCRYPTION_KEY) {
    tokenEncryptionKey = parseKey(env.TOKEN_ENCRYPTION_KEY);
  }
  if (dbPath && !tokenEncryptionKey && !allowInsecureTokenStorage) {
    throw new ConfigError(
      "TOKEN_ENCRYPTION_KEY is required when DB_PATH is set (or set ALLOW_INSECURE_TOKEN_STORAGE=1 for dev)",
    );
  }
  if (offlineReceive.covenantDestinations && (!dbPath || dbPath === ":memory:")) {
    throw new ConfigError("OFFLINE_COVENANT_DESTINATIONS=true requires a file-backed DB_PATH (contracts and settlement attribution must survive restart)");
  }

  // Sats, and policy rather than protocol: arkd's dust says what it will accept,
  // not what is worth accepting. A payer delivering an onchain receive pays a
  // Bitcoin transaction fee this server cannot see — hundreds to thousands of
  // sats — so advertising a dust-sized onchain minimum invites payments that cost
  // more to make than they deliver. Never lowers the rail below dust.
  const onchainMinSendableSats = integer(env, "ONCHAIN_MIN_SENDABLE_SATS", 10_000, { min: 1 });
  const minSendable = integer(env, "MIN_SENDABLE", 1_000, { min: 1 });
  const maxSendable = integer(env, "MAX_SENDABLE", 100_000_000_000, { min: 1 });
  if (maxSendable < minSendable) throw new ConfigError("MAX_SENDABLE must be greater than or equal to MIN_SENDABLE");
  const baseUrl = env.BASE_URL ? httpUrl(env.BASE_URL, "BASE_URL") : `http://localhost:${port}`;
  const adminPort = integer(env, "ADMIN_PORT", 3001, { min: 1, max: 65_535 });
  if (dbPath && adminPort === port) throw new ConfigError("ADMIN_PORT must differ from PORT when DB_PATH is set");
  const fixedFloat = buildFixedFloat(env, dbPath, offlineReceive);

  return {
    port,
    baseUrl,
    minSendable,
    maxSendable,
    onchainMinSendableSats,
    invoiceTimeoutMs: integer(env, "INVOICE_TIMEOUT_MS", 30_000, { min: 1 }),
    verifyTtlMs: integer(env, "VERIFY_TTL_MS", 86_400_000, { min: 1 }),
    destinationWatchMs: integer(env, "DESTINATION_WATCH_MS", 604_800_000, { min: 1 }),
    dbPath,
    adminPort,
    adminBind: env.ADMIN_BIND || "127.0.0.1",
    tokenEncryptionKey,
    allowInsecureTokenStorage,
    bootstrapDomain: env.BOOTSTRAP_DOMAIN || undefined,
    registrationRateLimitPerMin: integer(env, "REGISTRATION_RATE_LIMIT", 10, { min: 1 }),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    traceRequests,
    maxSessions: integer(env, "MAX_SESSIONS", 5_000, { min: 1 }),
    maxSessionsPerIp: integer(env, "MAX_SESSIONS_PER_IP", 50, { min: 1 }),
    maxConcurrentOfflineQuotes: integer(env, "MAX_CONCURRENT_OFFLINE_QUOTES", 20, { min: 1 }),
    shutdownTimeoutMs: integer(env, "SHUTDOWN_TIMEOUT_MS", 15_000, { min: 1 }),
    offlineReceive,
    ...(fixedFloat ? { fixedFloat } : {}),
  };
}

function ffCodes(raw: string | undefined, name: string): string[] | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const codes = raw.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
  const unknown = codes.filter((c) => !(c in FF_ASSETS));
  if (unknown.length) throw new ConfigError(`${name} names ${unknown.join(", ")}, not in the token table (known: ${Object.keys(FF_ASSETS).join(", ")})`);
  return codes;
}

function buildFixedFloat(env: Env, dbPath: string | undefined, offlineReceive: OfflineReceiveConfig): FixedFloatConfig | undefined {
  const apiKey = env.FIXEDFLOAT_API_KEY || undefined;
  const apiSecret = env.FIXEDFLOAT_API_SECRET || undefined;
  const simulateRaw = env.FIXEDFLOAT_SIMULATE;
  if (simulateRaw !== undefined && simulateRaw !== "" && simulateRaw !== "true" && simulateRaw !== "false") {
    throw new ConfigError("FIXEDFLOAT_SIMULATE must be true or false");
  }
  const simulate = simulateRaw === "true";
  if (Boolean(apiKey) !== Boolean(apiSecret)) throw new ConfigError("FIXEDFLOAT_API_KEY and FIXEDFLOAT_API_SECRET go together: set both or neither");
  if (simulate && apiKey) {
    throw new ConfigError("FIXEDFLOAT_SIMULATE=true cannot run with FIXEDFLOAT_API_KEY set: a simulated rail must never be mistaken for the real one");
  }
  if (!apiKey && !simulate) return undefined;
  if (!dbPath || dbPath === ":memory:") {
    throw new ConfigError("token deposits need a file-backed DB_PATH: an order lost on restart is a payer's support case nobody can resolve");
  }
  if (!offlineReceive.enabled) {
    throw new ConfigError("token deposits pay out over offline receive, which is not configured (ARK_SERVER_URL, solver cards, and COVCLAIMD_URL or OFFLINE_SELF_CLAIM)");
  }
  const afftaxRaw = env.FIXEDFLOAT_AFFTAX;
  const afftax = afftaxRaw === undefined || afftaxRaw === "" ? undefined : Number(afftaxRaw);
  if (afftax !== undefined && !(Number.isFinite(afftax) && afftax >= 0)) throw new ConfigError("FIXEDFLOAT_AFFTAX must be a non-negative number (a percentage)");
  const allow = ffCodes(env.FIXEDFLOAT_ALLOW, "FIXEDFLOAT_ALLOW");
  return {
    mode: simulate ? "simulate" : "live",
    ...(apiKey && apiSecret ? { auth: ffAuth(apiKey, apiSecret) } : {}),
    ...(env.FIXEDFLOAT_REFCODE ? { refcode: env.FIXEDFLOAT_REFCODE } : {}),
    ...(afftax !== undefined ? { afftax } : {}),
    ...(allow ? { allow } : {}),
    deny: ffCodes(env.FIXEDFLOAT_DENY, "FIXEDFLOAT_DENY") ?? [],
    baseUrl: env.FIXEDFLOAT_BASE_URL ? httpUrl(env.FIXEDFLOAT_BASE_URL, "FIXEDFLOAT_BASE_URL") : "https://ff.io/api/v2",
    ratesUrl: env.FIXEDFLOAT_RATES_URL ? httpUrl(env.FIXEDFLOAT_RATES_URL, "FIXEDFLOAT_RATES_URL") : "https://ff.io/rates/fixed.xml",
    windowSeconds: integer(env, "FIXEDFLOAT_WINDOW_SECONDS", 900, { min: 60 }),
    settleMarginSeconds: integer(env, "FIXEDFLOAT_SETTLE_MARGIN_SECONDS", 600, { min: 0 }),
    refreshMs: integer(env, "FIXEDFLOAT_REFRESH_MS", 300_000, { min: 10_000 }),
    maxOpenOrders: integer(env, "FIXEDFLOAT_MAX_OPEN_ORDERS", 20, { min: 1 }),
  };
}

/** Called once arkd has said which network it is on. FixedFloat has no testnet, so real keys
 *  anywhere but mainnet would take a payer's real tokens for test sats; the simulator is the
 *  reverse. Every push to main auto-deploys to mutinynet, so this refuses to start. */
export function assertFixedFloatNetwork(ff: FixedFloatConfig | undefined, network: unknown): void {
  if (!ff) return;
  if (ff.mode === "live" && network !== "bitcoin") {
    throw new ConfigError(`FIXEDFLOAT_API_KEY is set but arkd is on ${String(network)}: FixedFloat has no testnet, so real tokens would buy ${String(network)} sats (use FIXEDFLOAT_SIMULATE=true off mainnet)`);
  }
  if (ff.mode === "simulate" && network === "bitcoin") {
    throw new ConfigError("FIXEDFLOAT_SIMULATE=true refuses to run on bitcoin: the simulator takes no real deposit");
  }
}

function buildOfflineReceive(env: Env): OfflineReceiveConfig {
  const registryUrls = env.SOLVER_REGISTRY_URLS === undefined
    ? undefined
    : csvHttpUrls(env.SOLVER_REGISTRY_URLS, "SOLVER_REGISTRY_URLS");
  const cardsFile = env.SOLVER_CARDS_FILE?.trim() || undefined;
  const nostrSecretKey = env.NOSTR_SECRET_KEY || undefined;
  if (nostrSecretKey && !/^[0-9a-f]{64}$/i.test(nostrSecretKey)) {
    throw new ConfigError("NOSTR_SECRET_KEY must be 64-char hex");
  }
  const covclaimdUrl = env.COVCLAIMD_URL ? httpUrl(env.COVCLAIMD_URL, "COVCLAIMD_URL") : undefined;
  const arkServerUrl = env.ARK_SERVER_URL ? httpUrl(env.ARK_SERVER_URL, "ARK_SERVER_URL") : undefined;
  const rfqHttpUrl = env.SOLVER_RFQ_HTTP_URL ? httpUrl(env.SOLVER_RFQ_HTTP_URL, "SOLVER_RFQ_HTTP_URL") : undefined;
  const hasCards = (registryUrls?.length ?? 0) > 0 || cardsFile !== undefined;
  const emulatorUrl = env.OFFLINE_EMULATOR_URL ? httpUrl(env.OFFLINE_EMULATOR_URL, "OFFLINE_EMULATOR_URL") : undefined;
  // On wherever it can run. This server generates the swap preimage, so it can
  // push the covenant's claim leaf itself — no key of its own, and the covenant
  // pins the payout to the user. Deferring to covclaimd instead makes a third
  // party the single point of failure for every receive, and it cannot claim
  // this covenant today, so a covclaimd-only deployment claims nothing at all.
  // "false" still opts out; anything else is not a vote.
  const selfClaim = env.OFFLINE_SELF_CLAIM === undefined ? Boolean(emulatorUrl) : env.OFFLINE_SELF_CLAIM === "true";
  const stampClaimPacket = env.OFFLINE_STAMP_CLAIM_PACKET === "true";
  const covenantDestinations = env.OFFLINE_COVENANT_DESTINATIONS === "true";
  if (selfClaim && !emulatorUrl) {
    throw new ConfigError("OFFLINE_SELF_CLAIM=true requires OFFLINE_EMULATOR_URL (the emulator co-signs the covenant claim)");
  }
  if (emulatorUrl && !selfClaim && !covenantDestinations) {
    throw new ConfigError("OFFLINE_EMULATOR_URL requires OFFLINE_SELF_CLAIM=true or OFFLINE_COVENANT_DESTINATIONS=true");
  }
  const anyOfflineSetting = hasCards || covclaimdUrl || arkServerUrl || nostrSecretKey || selfClaim || emulatorUrl || stampClaimPacket || covenantDestinations || rfqHttpUrl;
  // The claim packet is optional on the wire (solver funds without covclaimd and
  // waits for the client's own claim): with OFFLINE_SELF_CLAIM the server holds
  // P and pushes the covenant leaf itself, so no covclaimd is needed.
  const selfClaimMode = selfClaim && emulatorUrl;
  // Configuration that only makes sense for the solver-mediated lightning rail.
  // OFFLINE_EMULATOR_URL is deliberately absent: it serves the covenant rail too.
  const offlineSwapRequested =
    hasCards || Boolean(covclaimdUrl) || Boolean(rfqHttpUrl) || Boolean(nostrSecretKey) || env.OFFLINE_SELF_CLAIM === "true";
  if (stampClaimPacket && !covclaimdUrl) {
    throw new ConfigError("OFFLINE_STAMP_CLAIM_PACKET=true requires COVCLAIMD_URL (there is no packet to stamp without one)");
  }
  if (anyOfflineSetting && !arkServerUrl) {
    throw new ConfigError("offline receive requires ARK_SERVER_URL; cards may come from env, file, or the admin database (COVCLAIMD_URL may be omitted with OFFLINE_SELF_CLAIM=true + OFFLINE_EMULATOR_URL)");
  }
  if ((hasCards || nostrSecretKey || stampClaimPacket) && !covclaimdUrl && !selfClaimMode) {
    throw new ConfigError("offline receive requires COVCLAIMD_URL (or OFFLINE_SELF_CLAIM=true with OFFLINE_EMULATOR_URL to run without covclaimd); cards may come from env, file, or the admin database");
  }
  // Same reasoning as selfClaim: a payer must never be handed an address nothing
  // can sweep, and by then their money is already at it.
  if (covenantDestinations && !emulatorUrl) {
    throw new ConfigError("OFFLINE_COVENANT_DESTINATIONS=true requires OFFLINE_EMULATOR_URL (the emulator co-signs the sweep)");
  }
  if (covenantDestinations && !(arkServerUrl && emulatorUrl)) {
    throw new ConfigError("OFFLINE_COVENANT_DESTINATIONS=true requires ARK_SERVER_URL and OFFLINE_EMULATOR_URL (the covenant commits to their keys; COVCLAIMD_URL is only needed alongside the lightning offline swap)");
  }
  const recoveryRaw = env.OFFLINE_COVENANT_RECOVERY_DELAY_SECONDS;
  // 512-second granularity, and 24h is not a multiple of it. Rejected here rather
  // than rounded: BIP68 throws on anything else, and the only place that surfaces
  // is per-payment derivation, which falls back to the static address and hands
  // the payer the ambiguity this flag exists to remove.
  const covenantRecoveryDelaySeconds = recoveryRaw ? Number(recoveryRaw) : 86_528;
  if (!Number.isInteger(covenantRecoveryDelaySeconds) || covenantRecoveryDelaySeconds <= 0) {
    throw new ConfigError(`OFFLINE_COVENANT_RECOVERY_DELAY_SECONDS must be a positive integer (got "${recoveryRaw}")`);
  }
  if (covenantRecoveryDelaySeconds % 512 !== 0) {
    const near = Math.round(covenantRecoveryDelaySeconds / 512) * 512;
    throw new ConfigError(
      `OFFLINE_COVENANT_RECOVERY_DELAY_SECONDS must be a multiple of 512 (BIP68 encodes seconds in 512s units); got ${covenantRecoveryDelaySeconds}, nearest is ${near}`,
    );
  }
  return {
    // Two separate questions, previously one. A claimer must exist — but an
    // emulator is also the covenant rail's co-signer, so it cannot by itself
    // mean "serve lightning swaps too", or turning self-claim on by default
    // would switch this rail on for a covenant-only deployment.
    enabled: Boolean(arkServerUrl && (covclaimdUrl || (selfClaim && emulatorUrl)) && offlineSwapRequested),
    registryUrls,
    stampClaimPacket,
    selfClaim,
    covenantDestinations,
    covenantRecoveryDelaySeconds,
    pollIntervalMs: integer(env, "OFFLINE_POLL_INTERVAL_MS", 15_000, { min: 1 }),
    ...(emulatorUrl ? { emulatorUrl } : {}),
    ...(cardsFile ? { cardsFile } : {}),
    ...(nostrSecretKey ? { nostrSecretKey } : {}),
    ...(covclaimdUrl ? { covclaimdUrl } : {}),
    ...(arkServerUrl ? { arkServerUrl } : {}),
    ...(rfqHttpUrl ? { rfqHttpUrl } : {}),
  };
}

function parseTrustProxy(raw: string | undefined): number | boolean {
  if (raw === undefined || raw === "") return 1;
  if (raw === "false") return false;
  if (!/^\d+$/.test(raw)) throw new ConfigError("TRUST_PROXY must be false or a non-negative integer");
  return Number(raw);
}
