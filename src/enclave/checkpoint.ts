import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from "node:zlib";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, type KeyObject } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../db/connection.js";
import { LATEST_MIGRATION, runMigrations } from "../db/migrations.js";
import { checkpointPrefix } from "./checkpoint-key.js";
import type { EnclaveStorage } from "./storage.js";
import type { StatementPayload, WireHead } from "./authority-wire.js";
import { AuthorityRefusal, type CheckpointAuthority } from "./authority-client.js";

const SCHEMA = "lnurl.enclave.checkpoint.v2";

export interface CheckpointHead {
  schema: typeof SCHEMA;
  prefix: string;
  sequence: number;
  /** SHA-256 of the plaintext database image; what dedupe and restore check against. */
  digest: string;
  /** Plaintext size in bytes. */
  size: number;
  /** SHA-256 of the sealed object as stored. It names the object, and is what a pin names. */
  ciphertextDigest: string;
  key: string;
  schemaVersion: number;
  /** The writer epoch the object was sealed under: granted by the authority, 0 without one. */
  epoch: number;
  /** The previous head's `ciphertextDigest`. */
  previousDigest: string | null;
}

/** Which deployment a snapshot belongs to, and the key that seals it. */
export interface CheckpointSeal {
  key: Uint8Array;
  deployment: string;
}

const headSuffix = "/HEAD.json";
const snapshotSuffix = ".sqlite.br.enc";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** Measured on a real 256 MB snapshot: fastest to encode of the codecs tried and
 *  also the smallest, so the ~24x reduction costs nothing to trade. Transfer was
 *  over half of a barrier's time even on loopback. */
const BROTLI_QUALITY = 1;

function compress(snapshot: Uint8Array): Buffer {
  return brotliCompressSync(snapshot, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } });
}

/** Bounded by the plaintext size the head claims, which stops a small object
 *  expanding without limit. Every field of the head is authenticated before this
 *  runs, so the host cannot choose that size either. */
function decompress(stored: Uint8Array, plaintextSize: number): Uint8Array {
  try {
    return brotliDecompressSync(stored, { maxOutputLength: plaintextSize });
  } catch (error) {
    throw new Error(`checkpoint snapshot does not match its authoritative metadata: ${(error as Error).message}`);
  }
}

function assertSeal(seal: CheckpointSeal): void {
  if (seal.key.length !== 32) throw new Error("checkpoint storage key must be 32 bytes");
  if (!seal.deployment) throw new Error("checkpoint seal needs a deployment identity");
}

/**
 * Binds every head field except the two derived from the ciphertext itself, so a
 * host that edits the metadata it serves makes the snapshot fail to open. A JSON
 * array is canonical here: fixed order, and string fields are delimited by quoting.
 */
function associatedData(seal: CheckpointSeal, head: Omit<CheckpointHead, "key" | "ciphertextDigest">): Buffer {
  return Buffer.from(JSON.stringify([
    head.schema, seal.deployment, head.prefix, head.schemaVersion, head.epoch,
    head.sequence, head.previousDigest, head.digest, head.size,
  ]));
}

function sealSnapshot(seal: CheckpointSeal, aad: Buffer, plaintext: Uint8Array): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", seal.key, nonce);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

function openSealed(seal: CheckpointSeal, aad: Buffer, stored: Uint8Array): Buffer {
  const bytes = Buffer.from(stored);
  if (bytes.length < NONCE_BYTES + TAG_BYTES) throw new Error("checkpoint snapshot could not be authenticated");
  try {
    const decipher = createDecipheriv("aes-256-gcm", seal.key, bytes.subarray(0, NONCE_BYTES));
    decipher.setAAD(aad);
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
    return Buffer.concat([decipher.update(bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw new Error("checkpoint snapshot could not be authenticated");
  }
}

/** A head as the checkpoint authority carries it, whose `sealEpoch` is this `epoch`. */
export function headFromWire(w: WireHead): CheckpointHead {
  return {
    schema: w.schema as typeof SCHEMA, prefix: w.prefix, sequence: w.sequence, digest: w.digest, size: w.size,
    ciphertextDigest: w.ciphertextDigest, key: w.key, schemaVersion: w.schemaVersion, epoch: w.sealEpoch, previousDigest: w.previousDigest,
  };
}

function parseHead(value: Uint8Array | undefined, prefix: string): CheckpointHead | undefined {
  if (!value) return undefined;
  let head: CheckpointHead;
  try {
    head = JSON.parse(Buffer.from(value).toString()) as CheckpointHead;
  } catch {
    throw new Error("checkpoint head is not valid JSON");
  }
  return checkedHead(head, prefix);
}

function checkedHead(head: CheckpointHead, prefix: string): CheckpointHead {
  const hex64 = (v: unknown): boolean => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
  if (
    head?.schema !== SCHEMA
    || head.prefix !== prefix
    || !Number.isSafeInteger(head.sequence) || head.sequence < 1
    || !hex64(head.digest)
    || !Number.isSafeInteger(head.size) || head.size < 1
    || !hex64(head.ciphertextDigest)
    || head.key !== `${prefix}/${head.ciphertextDigest}${snapshotSuffix}`
    || !Number.isSafeInteger(head.schemaVersion) || head.schemaVersion < 0
    || !Number.isSafeInteger(head.epoch) || head.epoch < 0
    || head.previousDigest !== null && !hex64(head.previousDigest)
  ) {
    throw new Error("checkpoint head metadata is invalid");
  }
  return head;
}

export async function restoreCheckpoint(options: {
  dbPath: string;
  storage: EnclaveStorage;
  prefix: string;
  seal: CheckpointSeal;
  expectedDigest?: string;
  minSequence?: number;
  /** The head a verified authority statement named, or null for none committed. When
   *  given, HEAD.json is never read. */
  authorityHead?: CheckpointHead | null;
}): Promise<{ db: Db; head: CheckpointHead } | undefined> {
  assertSeal(options.seal);
  const prefix = checkpointPrefix(options.prefix);
  const fromAuthority = options.authorityHead !== undefined;
  const head = fromAuthority
    ? options.authorityHead && checkedHead(options.authorityHead, prefix)
    : parseHead(await options.storage.load(`${prefix}${headSuffix}`), prefix);
  if (!head) {
    // The chain in a head is self-consistent at every sequence, so replaying an
    // older one is indistinguishable from the truth without an outside opinion.
    if (options.expectedDigest || options.minSequence) {
      throw new Error(`checkpoint head is pinned but ${fromAuthority ? "the authority names" : "the host served"} none`);
    }
    return undefined;
  }
  if (options.expectedDigest && head.ciphertextDigest !== options.expectedDigest) {
    throw new Error(`checkpoint head ${head.ciphertextDigest} is not the pinned head ${options.expectedDigest}`);
  }
  if (options.minSequence && head.sequence < options.minSequence) {
    throw new Error(`checkpoint head is at sequence ${head.sequence}, behind the pinned floor ${options.minSequence}`);
  }

  const stored = await options.storage.load(head.key);
  if (!stored) throw new Error("authoritative checkpoint snapshot is missing");
  if (sha256(stored) !== head.ciphertextDigest) {
    throw new Error("checkpoint snapshot does not match its authoritative metadata");
  }
  const snapshot = decompress(openSealed(options.seal, associatedData(options.seal, head), stored), head.size);
  if (sha256(snapshot) !== head.digest || BigInt(snapshot.byteLength) !== BigInt(head.size)) {
    throw new Error("checkpoint snapshot does not match its authoritative metadata");
  }

  return { db: openRestored(options.dbPath, snapshot), head };
}

/** A consistent copy of the database as bytes, including committed WAL content.
 *  `VACUUM INTO` rather than `DatabaseSync.serialize`, which the pinned Node 22
 *  runtime does not have. SQLite refuses it inside a transaction, so every write
 *  in this codebase must open and close one within a single synchronous block:
 *  an await between BEGIN and COMMIT would let a checkpoint land inside it. */
function snapshotBytes(db: Db, scratchDir: string): Uint8Array {
  const target = join(scratchDir, `checkpoint-${randomUUID()}.sqlite`);
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    return readFileSync(target);
  } finally {
    rmSync(target, { force: true });
  }
}

function openRestored(dbPath: string, snapshot: Uint8Array): Db {
  if (dbPath === ":memory:") {
    throw new Error("restoring a checkpoint needs a file-backed DB_PATH");
  }

  // The snapshot has to be on disk before openDb enables WAL on it, and any sidecar
  // left by an earlier image would be replayed into this one.
  writeFileSync(dbPath, snapshot);
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  let db: Db | undefined;
  try {
    db = openDb(dbPath);
    db.prepare("SELECT count(*) AS n FROM sqlite_schema").get();
    return db;
  } catch (error) {
    db?.close();
    throw new Error(`authoritative checkpoint is not a valid SQLite database: ${(error as Error).message}`);
  }
}

/** Held by anything that must not cause an external effect the enclave could forget. */
export interface DurabilityBarrier {
  barrier(): Promise<void>;
  /** False while a checkpoint could not be committed now, so no effect should start. */
  writable?(): boolean;
}

export interface CheckpointStore extends DurabilityBarrier {
  flush(): Promise<CheckpointHead | undefined>;
  start(): void;
  stop(): Promise<void>;
  status(): { ok: boolean; detail?: string };
}

/** What activation granted this boot: the epoch it writes under, and its key. */
export interface WriterGrant {
  client: CheckpointAuthority;
  deployment: string;
  epoch: number;
  /** Ed25519 private key, generated this boot. */
  writer: KeyObject;
  writerPublicKey: Uint8Array;
}

export function headToWire(h: CheckpointHead): WireHead {
  return {
    schema: h.schema, prefix: h.prefix, schemaVersion: h.schemaVersion, sealEpoch: h.epoch, sequence: h.sequence,
    previousDigest: h.previousDigest, digest: h.digest, size: h.size, ciphertextDigest: h.ciphertextDigest, key: h.key,
  };
}

export function createCheckpointStore(options: {
  db: Db;
  storage: EnclaveStorage;
  prefix: string;
  seal: CheckpointSeal;
  intervalMs: number;
  head?: CheckpointHead;
  now?: () => number;
  /** Where the snapshot is staged. Keep it on the same RAM-backed filesystem as
   *  the database, so no plaintext copy lands on a mount the caller did not choose. */
  scratchDir?: string;
  /** Present: every commit goes through the authority, and HEAD.json is only a hint. */
  authority?: WriterGrant;
  /** Called once, when the authority has refused this writer for good. */
  onTerminal?: (error: Error) => void;
}): CheckpointStore {
  assertSeal(options.seal);
  const prefix = checkpointPrefix(options.prefix);
  const scratchDir = options.scratchDir ?? tmpdir();
  const now = options.now ?? Date.now;
  // Reporting the last attempt hides a store that has stopped attempting at all.
  const staleAfterMs = Math.max(options.intervalMs * 6, 30_000);
  let head = options.head;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<CheckpointHead | undefined> | undefined;
  let last = { ok: true, detail: "checkpoint storage ready" };
  let durableAt = now();
  // This connection's row-change count when the last committed snapshot was taken.
  // Unknown until the first flush, so the first barrier always takes one.
  let committed = -1;
  const totalChanges = options.db.prepare("SELECT total_changes() AS n");
  const changes = () => (totalChanges.get() as { n: number }).n;
  // A commit whose answer never came: it may have landed, so the next flush asks first.
  let pending: { operationId: string; head: CheckpointHead; mark: number } | undefined;
  let stopped: Error | undefined;

  // The local database now holds writes the authority will never accept, so this
  // writer cannot continue; only a restart restores what the authority committed.
  function halt(error: Error): never {
    if (!stopped) {
      stopped = error;
      options.onTerminal?.(error);
    }
    throw error;
  }

  async function reconcile(grant: WriterGrant, p: NonNullable<typeof pending>): Promise<void> {
    let st: StatementPayload;
    try {
      st = await grant.client.state(randomBytes(16));
    } catch (error) {
      if (error instanceof AuthorityRefusal) halt(error);
      throw error;
    }
    if (st.activeEpoch !== grant.epoch || !Buffer.from(st.activeWriterPublicKey).equals(Buffer.from(grant.writerPublicKey))) {
      halt(new Error(`writer fenced: the authority's active epoch is ${st.activeEpoch}`));
    }
    if (st.currentOperationId === p.operationId && st.head?.ciphertextDigest === p.head.ciphertextDigest) {
      head = p.head;
      committed = p.mark;
    } else if (st.sequence !== (head?.sequence ?? 0) || (st.head?.ciphertextDigest ?? null) !== (head?.ciphertextDigest ?? null)) {
      halt(new Error(`the authority's head moved to ${st.head?.ciphertextDigest ?? "none"} without this writer`));
    }
    pending = undefined;
  }

  async function commit(grant: WriterGrant, previous: CheckpointHead | undefined, next: CheckpointHead, mark: number): Promise<void> {
    const operationId = randomBytes(16).toString("hex");
    pending = { operationId, head: next, mark };
    let st: StatementPayload;
    try {
      st = await grant.client.commit({
        deployment: grant.deployment, epoch: grant.epoch, operationId, expectedSequence: previous?.sequence ?? 0,
        priorDigest: previous?.ciphertextDigest ?? null, head: headToWire(next),
      }, grant.writer);
    } catch (error) {
      if (error instanceof AuthorityRefusal) halt(error);
      throw error;
    }
    pending = undefined;
    if (st.currentOperationId !== operationId || st.head?.ciphertextDigest !== next.ciphertextDigest) {
      halt(new Error("the authority acknowledged a commit that is not this one"));
    }
    if (st.activeEpoch !== grant.epoch) halt(new Error(`writer fenced: the authority's active epoch is ${st.activeEpoch}`));
    void options.storage.put(`${prefix}${headSuffix}`, Buffer.from(JSON.stringify({ ...next, authoritative: false }))).catch(() => {});
  }

  async function flush(): Promise<CheckpointHead | undefined> {
    if (running) return running;
    running = (async () => {
      try {
        if (stopped) throw stopped;
        const grant = options.authority;
        if (grant && pending) await reconcile(grant, pending);
        // Same synchronous step as the snapshot, so no write can land between them.
        const mark = changes();
        const snapshot = snapshotBytes(options.db, scratchDir);
        const digest = sha256(snapshot);
        if (head?.digest === digest) {
          // Nothing changed, so what is stored is still exactly this state.
          last = { ok: true, detail: `checkpoint ${head.sequence} committed` };
          durableAt = now();
          committed = mark;
          return head;
        }
        const previousHead = head;
        const meta = {
          schema: SCHEMA,
          prefix,
          sequence: (previousHead?.sequence ?? 0) + 1,
          digest,
          size: snapshot.byteLength,
          schemaVersion: migrationVersion(options.db),
          epoch: grant?.epoch ?? 0,
          previousDigest: previousHead?.ciphertextDigest ?? null,
        } as const;
        const stored = sealSnapshot(options.seal, associatedData(options.seal, meta), compress(snapshot));
        const ciphertextDigest = sha256(stored);
        const key = `${prefix}/${ciphertextDigest}${snapshotSuffix}`;
        await options.storage.put(key, stored);
        const next: CheckpointHead = { ...meta, ciphertextDigest, key };
        if (grant) {
          await commit(grant, previousHead, next, mark);
        } else {
          // Two enclaves on one prefix each extend their own chain, and whichever writes
          // HEAD last erases the other's history. Detection only: closing the window
          // between this read and the write below needs the authority's compare-and-set.
          const remote = parseHead(await options.storage.load(`${prefix}${headSuffix}`), prefix);
          if (remote?.ciphertextDigest !== previousHead?.ciphertextDigest) {
            throw new Error(`another writer advanced the checkpoint head to ${remote?.ciphertextDigest ?? "none"}`);
          }
          await options.storage.put(`${prefix}${headSuffix}`, Buffer.from(JSON.stringify(next)));
        }
        head = next;
        committed = mark;
        last = { ok: true, detail: `checkpoint ${next.sequence} committed` };
        durableAt = now();
        return next;
      } catch (error) {
        last = { ok: false, detail: stopped ? `checkpoint writer stopped: ${stopped.message}` : `checkpoint failed: ${(error as Error).message}` };
        throw error;
      } finally {
        running = undefined;
      }
    })();
    return running;
  }

  // A flush in flight may have snapshotted before the caller's write, so it is waited
  // out and trusted only if the mark it committed reaches that write.
  async function barrier(): Promise<void> {
    const target = changes();
    if (committed >= target) return;
    const inFlight = running;
    if (inFlight) await inFlight.catch(() => {});
    if (committed >= target) return;
    await flush();
  }

  return {
    flush,
    barrier,
    writable: () => !stopped && last.ok,
    start() {
      timer = setInterval(() => void flush().catch(() => {}), options.intervalMs);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await flush();
    },
    status() {
      if (!last.ok) return last;
      const age = now() - durableAt;
      if (age <= staleAfterMs) return last;
      return { ok: false, detail: `no checkpoint committed for ${Math.round(age / 1000)}s` };
    },
  };
}

export function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function migrationVersion(db: Db): number {
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
  return row.v ?? 0;
}

export { LATEST_MIGRATION, runMigrations, openDb, checkpointPrefix };
