import { createPublicKey } from "node:crypto";
import { isIP } from "node:net";
import { checkpointPrefix } from "./enclave/checkpoint-key.js";

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
  /** Settlement-pass interval, ms. Not what claims a lockup — src/lockup-watcher.ts
   *  does that on the funding event — so what is left on it is the backstop for a
   *  dropped subscription and the solver status check the RFQ transport cannot push. */
  pollIntervalMs: number;
}

export interface AuthorityConfig {
  url: string;
  /** SPKI DER of the P-256 keys the authority may sign with; two only during a rotation. */
  publicKeys: Buffer[];
  timeoutMs: number;
  maxSkewMs: number;
  /** The release this image belongs to, fixed before the build so the operator approves
   *  exactly these measurements at exactly this version. */
  releasePolicyVersion: number;
}

export interface EnclaveCheckpointConfig {
  enabled: boolean;
  /** Present: the checkpoint authority, not HEAD.json, names the current snapshot. */
  authority?: AuthorityConfig;
  /** Bucket holding this deployment's sealed snapshots and head. */
  s3Bucket?: string;
  /** Same variable and default the runtime uses, so the two agree by construction. */
  awsRegion: string;
  allowGenesis: boolean;
  checkpointIntervalMs: number;
  checkpointKey: string;
  /** Digest the security administrator says is current. Without it the host
   *  chooses which history the enclave wakes up on. */
  expectedHead?: string;
  /** Floor on the head's sequence. Survives a crash, where nobody outside the
   *  enclave knows which digest the timer wrote last. */
  minSequence?: number;
  /** Bound into every sealed snapshot. Measured, and not SSM-overridable, inside Enclave. */
  deployment: string;
  /** Seals snapshots; kept apart from the token key. */
  storageKey?: Buffer;
}

export interface AppConfig {
  port: number;
  publicBind?: string;
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
  enclaveCheckpoint: EnclaveCheckpointConfig;
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

function expectedHead(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (!/^[0-9a-f]{64}$/.test(raw)) throw new Error("ENCLAVE_CHECKPOINT_HEAD must be a 64-character lowercase hex digest");
  return raw;
}

function authorityConfig(env: Env): AuthorityConfig | undefined {
  const url = env.ENCLAVE_AUTHORITY_URL || undefined;
  const keys = env.ENCLAVE_AUTHORITY_PUBLIC_KEYS || undefined;
  if (!url && !keys) return undefined;
  if (!url || !keys) throw new Error("ENCLAVE_AUTHORITY_URL and ENCLAVE_AUTHORITY_PUBLIC_KEYS go together: a statement is trusted only under a pinned key");
  if (!/^https?:$/.test(new URL(url).protocol)) throw new Error("ENCLAVE_AUTHORITY_URL must be an http(s) URL");
  const publicKeys = keys.split(",").map((k) => Buffer.from(k.trim(), "base64"));
  if (publicKeys.length > 2) throw new Error("ENCLAVE_AUTHORITY_PUBLIC_KEYS takes one key, or two during a rotation");
  for (const spki of publicKeys) {
    let curve: string | undefined;
    try {
      curve = createPublicKey({ key: spki, format: "der", type: "spki" }).asymmetricKeyDetails?.namedCurve;
    } catch {
      curve = undefined;
    }
    if (curve !== "prime256v1") throw new Error("ENCLAVE_AUTHORITY_PUBLIC_KEYS must be base64 SPKI P-256 keys");
  }
  return {
    url, publicKeys,
    timeoutMs: integer(env, "ENCLAVE_AUTHORITY_TIMEOUT_MS", 10_000, { min: 100 }),
    maxSkewMs: integer(env, "ENCLAVE_AUTHORITY_SKEW_MS", 300_000, { min: 1_000 }),
    releasePolicyVersion: integer(env, "ENCLAVE_RELEASE_POLICY_VERSION", 1, { min: 1 }),
  };
}

function parseKey(raw: string, name: string): Buffer {
  const buf = /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0 ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error(`${name} must decode to 32 bytes (hex or base64)`);
  return buf;
}

export function loadConfig(env: Env = process.env): AppConfig {
  rejectRemovedSolverConfig(env);
  const port = integer(env, "PORT", 3000, { min: 1, max: 65_535 });
  const publicBind = env.PUBLIC_BIND || undefined;
  if (publicBind && !isIP(publicBind)) throw new Error("PUBLIC_BIND must be an IP address");
  const enabled = env.ENCLAVE_CHECKPOINT === "1";
  const checkpointKey = checkpointPrefix(env.ENCLAVE_CHECKPOINT_KEY || "lnurl/db");
  const dbPath = env.DB_PATH || (enabled ? "/run/lnurl/state.sqlite" : undefined);
  const allowInsecureTokenStorage = env.ALLOW_INSECURE_TOKEN_STORAGE === "1";
  const traceRequests = env.TRACE_REQUESTS === "1";
  const offlineReceive = buildOfflineReceive(env);

  const authority = authorityConfig(env);
  const enclaveCheckpoint: EnclaveCheckpointConfig = {
    enabled,
    ...(authority ? { authority } : {}),
    s3Bucket: env.ENCLAVE_S3_BUCKET || undefined,
    awsRegion: env.ENCLAVE_AWS_REGION || "us-east-1",
    allowGenesis: env.ENCLAVE_CHECKPOINT_ALLOW_GENESIS === "1",
    checkpointIntervalMs: integer(env, "ENCLAVE_CHECKPOINT_INTERVAL_MS", 5_000, { min: 100 }),
    checkpointKey,
    expectedHead: expectedHead(env.ENCLAVE_CHECKPOINT_HEAD),
    minSequence: env.ENCLAVE_CHECKPOINT_MIN_SEQUENCE === undefined
      ? undefined
      : integer(env, "ENCLAVE_CHECKPOINT_MIN_SEQUENCE", 1, { min: 1 }),
    deployment: env.ENCLAVE_DEPLOYMENT || "",
    storageKey: env.ENCLAVE_STORAGE_KEY ? parseKey(env.ENCLAVE_STORAGE_KEY, "ENCLAVE_STORAGE_KEY") : undefined,
  };
  if (enabled && !enclaveCheckpoint.s3Bucket) {
    throw new Error("ENCLAVE_S3_BUCKET is required when ENCLAVE_CHECKPOINT=1");
  }
  if (enabled && !enclaveCheckpoint.storageKey) {
    throw new Error("ENCLAVE_STORAGE_KEY is required when ENCLAVE_CHECKPOINT=1");
  }
  if (enabled && !enclaveCheckpoint.deployment) {
    throw new Error("ENCLAVE_DEPLOYMENT is required when ENCLAVE_CHECKPOINT=1");
  }
  // Genesis would accept this and checkpoint away, and only the restore after the
  // first restart would discover there is nowhere to put the snapshot.
  if (enabled && dbPath === ":memory:") {
    throw new Error("ENCLAVE_CHECKPOINT=1 needs a file-backed DB_PATH; a restored snapshot cannot be opened in memory");
  }
  if (enclaveCheckpoint.expectedHead && enclaveCheckpoint.allowGenesis) {
    throw new Error("ENCLAVE_CHECKPOINT_HEAD and ENCLAVE_CHECKPOINT_ALLOW_GENESIS contradict each other");
  }
  // Once the authority names the head, a digest pinned by hand can only be stale.
  if (enclaveCheckpoint.expectedHead && authority) {
    throw new Error("ENCLAVE_CHECKPOINT_HEAD and ENCLAVE_AUTHORITY_URL contradict each other: the authority names the head");
  }

  let tokenEncryptionKey: Buffer | undefined;
  if (env.TOKEN_ENCRYPTION_KEY) {
    tokenEncryptionKey = parseKey(env.TOKEN_ENCRYPTION_KEY, "TOKEN_ENCRYPTION_KEY");
  }
  if (enclaveCheckpoint.storageKey && tokenEncryptionKey?.equals(enclaveCheckpoint.storageKey)) {
    throw new Error("ENCLAVE_STORAGE_KEY must differ from TOKEN_ENCRYPTION_KEY");
  }
  if (dbPath && !tokenEncryptionKey && !allowInsecureTokenStorage) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is required when DB_PATH is set (or set ALLOW_INSECURE_TOKEN_STORAGE=1 for dev)",
    );
  }
  if (offlineReceive.covenantDestinations && (!dbPath || dbPath === ":memory:")) {
    throw new Error("OFFLINE_COVENANT_DESTINATIONS=true requires a file-backed DB_PATH (contracts and settlement attribution must survive restart)");
  }

  // Sats, and policy rather than protocol: arkd's dust says what it will accept,
  // not what is worth accepting. A payer delivering an onchain receive pays a
  // Bitcoin transaction fee this server cannot see — hundreds to thousands of
  // sats — so advertising a dust-sized onchain minimum invites payments that cost
  // more to make than they deliver. Never lowers the rail below dust.
  const onchainMinSendableSats = integer(env, "ONCHAIN_MIN_SENDABLE_SATS", 10_000, { min: 1 });
  const minSendable = integer(env, "MIN_SENDABLE", 1_000, { min: 1 });
  const maxSendable = integer(env, "MAX_SENDABLE", 100_000_000_000, { min: 1 });
  if (maxSendable < minSendable) throw new Error("MAX_SENDABLE must be greater than or equal to MIN_SENDABLE");
  const baseUrl = env.BASE_URL ? httpUrl(env.BASE_URL, "BASE_URL") : `http://localhost:${port}`;
  const adminPort = integer(env, "ADMIN_PORT", 3001, { min: 1, max: 65_535 });
  if (dbPath && adminPort === port) throw new Error("ADMIN_PORT must differ from PORT when DB_PATH is set");

  return {
    port,
    publicBind,
    baseUrl,
    minSendable,
    maxSendable,
    onchainMinSendableSats,
    invoiceTimeoutMs: integer(env, "INVOICE_TIMEOUT_MS", 30_000, { min: 1 }),
    verifyTtlMs: integer(env, "VERIFY_TTL_MS", 86_400_000, { min: 1 }),
    destinationWatchMs: integer(env, "DESTINATION_WATCH_MS", 604_800_000, { min: 1 }),
    dbPath,
    enclaveCheckpoint,
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
  };
}

function buildOfflineReceive(env: Env): OfflineReceiveConfig {
  const registryUrls = env.SOLVER_REGISTRY_URLS === undefined
    ? undefined
    : csvHttpUrls(env.SOLVER_REGISTRY_URLS, "SOLVER_REGISTRY_URLS");
  const cardsFile = env.SOLVER_CARDS_FILE?.trim() || undefined;
  const nostrSecretKey = env.NOSTR_SECRET_KEY || undefined;
  if (nostrSecretKey && !/^[0-9a-f]{64}$/i.test(nostrSecretKey)) {
    throw new Error("NOSTR_SECRET_KEY must be 64-char hex");
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
    throw new Error("OFFLINE_SELF_CLAIM=true requires OFFLINE_EMULATOR_URL (the emulator co-signs the covenant claim)");
  }
  if (emulatorUrl && !selfClaim && !covenantDestinations) {
    throw new Error("OFFLINE_EMULATOR_URL requires OFFLINE_SELF_CLAIM=true or OFFLINE_COVENANT_DESTINATIONS=true");
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
    throw new Error("OFFLINE_STAMP_CLAIM_PACKET=true requires COVCLAIMD_URL (there is no packet to stamp without one)");
  }
  if (anyOfflineSetting && !arkServerUrl) {
    throw new Error("offline receive requires ARK_SERVER_URL; cards may come from env, file, or the admin database (COVCLAIMD_URL may be omitted with OFFLINE_SELF_CLAIM=true + OFFLINE_EMULATOR_URL)");
  }
  if ((hasCards || nostrSecretKey || stampClaimPacket) && !covclaimdUrl && !selfClaimMode) {
    throw new Error("offline receive requires COVCLAIMD_URL (or OFFLINE_SELF_CLAIM=true with OFFLINE_EMULATOR_URL to run without covclaimd); cards may come from env, file, or the admin database");
  }
  // Same reasoning as selfClaim: a payer must never be handed an address nothing
  // can sweep, and by then their money is already at it.
  if (covenantDestinations && !emulatorUrl) {
    throw new Error("OFFLINE_COVENANT_DESTINATIONS=true requires OFFLINE_EMULATOR_URL (the emulator co-signs the sweep)");
  }
  if (covenantDestinations && !(arkServerUrl && emulatorUrl)) {
    throw new Error("OFFLINE_COVENANT_DESTINATIONS=true requires ARK_SERVER_URL and OFFLINE_EMULATOR_URL (the covenant commits to their keys; COVCLAIMD_URL is only needed alongside the lightning offline swap)");
  }
  const recoveryRaw = env.OFFLINE_COVENANT_RECOVERY_DELAY_SECONDS;
  // 512-second granularity, and 24h is not a multiple of it. Rejected here rather
  // than rounded: BIP68 throws on anything else, and the only place that surfaces
  // is per-payment derivation, which falls back to the static address and hands
  // the payer the ambiguity this flag exists to remove.
  const covenantRecoveryDelaySeconds = recoveryRaw ? Number(recoveryRaw) : 86_528;
  if (!Number.isInteger(covenantRecoveryDelaySeconds) || covenantRecoveryDelaySeconds <= 0) {
    throw new Error(`OFFLINE_COVENANT_RECOVERY_DELAY_SECONDS must be a positive integer (got "${recoveryRaw}")`);
  }
  if (covenantRecoveryDelaySeconds % 512 !== 0) {
    const near = Math.round(covenantRecoveryDelaySeconds / 512) * 512;
    throw new Error(
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
  if (!/^\d+$/.test(raw)) throw new Error("TRUST_PROXY must be false or a non-negative integer");
  return Number(raw);
}
