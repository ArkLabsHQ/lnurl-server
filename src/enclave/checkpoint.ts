import { createHash, randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../db/connection.js";
import { LATEST_MIGRATION, runMigrations } from "../db/migrations.js";
import { checkpointPrefix } from "./checkpoint-key.js";
import type { EnclaveStorage } from "./storage.js";

export interface CheckpointHead {
  schema: "lnurl.enclave.checkpoint.v1";
  prefix: string;
  sequence: number;
  digest: string;
  size: number;
  key: string;
  previousDigest?: string | null;
}

const headSuffix = "/HEAD.json";
const snapshotSuffix = ".sqlite";

function parseHead(value: Uint8Array | undefined, prefix: string): CheckpointHead | undefined {
  if (!value) return undefined;
  let head: CheckpointHead;
  try {
    head = JSON.parse(Buffer.from(value).toString()) as CheckpointHead;
  } catch {
    throw new Error("checkpoint head is not valid JSON");
  }
  const expectedKey = `${prefix}/${head.digest}${snapshotSuffix}`;
  if (
    head?.schema !== "lnurl.enclave.checkpoint.v1"
    || head.prefix !== prefix
    || !Number.isInteger(head.sequence)
    || head.sequence < 1
    || !/^[0-9a-f]{64}$/.test(head.digest)
    || !Number.isSafeInteger(head.size)
    || head.size < 1
    || head.key !== expectedKey
    || head.previousDigest !== null && !(typeof head.previousDigest === "string" && /^[0-9a-f]{64}$/.test(head.previousDigest))
  ) {
    throw new Error("checkpoint head metadata is invalid");
  }
  return head;
}

export async function restoreCheckpoint(options: {
  dbPath: string;
  storage: EnclaveStorage;
  prefix: string;
  expectedDigest?: string;
  minSequence?: number;
}): Promise<{ db: Db; head: CheckpointHead } | undefined> {
  const prefix = checkpointPrefix(options.prefix);
  const head = parseHead(await options.storage.load(`${prefix}${headSuffix}`), prefix);
  if (!head) {
    // The chain in a head is self-consistent at every sequence, so replaying an
    // older one is indistinguishable from the truth without an outside opinion.
    if (options.expectedDigest || options.minSequence) throw new Error("checkpoint head is pinned but the host served none");
    return undefined;
  }
  if (options.expectedDigest && head.digest !== options.expectedDigest) {
    throw new Error(`checkpoint head ${head.digest} is not the pinned head ${options.expectedDigest}`);
  }
  if (options.minSequence && head.sequence < options.minSequence) {
    throw new Error(`checkpoint head is at sequence ${head.sequence}, behind the pinned floor ${options.minSequence}`);
  }

  const snapshot = await options.storage.load(head.key);
  if (!snapshot) throw new Error("authoritative checkpoint snapshot is missing");
  const digest = sha256(snapshot);
  if (digest !== head.digest || BigInt(snapshot.byteLength) !== BigInt(head.size)) {
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
}

export interface CheckpointStore extends DurabilityBarrier {
  flush(): Promise<CheckpointHead | undefined>;
  start(): void;
  stop(): Promise<void>;
  status(): { ok: boolean; detail?: string };
}

export function createCheckpointStore(options: {
  db: Db;
  storage: EnclaveStorage;
  prefix: string;
  intervalMs: number;
  head?: CheckpointHead;
  now?: () => number;
  /** Where the snapshot is staged. Keep it on the same RAM-backed filesystem as
   *  the database, so no plaintext copy lands on a mount the caller did not choose. */
  scratchDir?: string;
}): CheckpointStore {
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

  async function flush(): Promise<CheckpointHead | undefined> {
    if (running) return running;
    running = (async () => {
      try {
        const snapshot = snapshotBytes(options.db, scratchDir);
        const digest = sha256(snapshot);
        if (head?.digest === digest) {
          // Nothing changed, so what is stored is still exactly this state.
          durableAt = now();
          return head;
        }
        const key = `${prefix}/${digest}${snapshotSuffix}`;
        const previousHead = head;
        await options.storage.put(key, snapshot);
        const next: CheckpointHead = {
          schema: "lnurl.enclave.checkpoint.v1",
          prefix,
          sequence: (previousHead?.sequence ?? 0) + 1,
          digest,
          size: snapshot.byteLength,
          key,
          previousDigest: previousHead?.digest ?? null,
        };
        await options.storage.put(`${prefix}${headSuffix}`, Buffer.from(JSON.stringify(next)));
        head = next;
        last = { ok: true, detail: `checkpoint ${next.sequence} committed` };
        durableAt = now();
        return next;
      } catch (error) {
        last = { ok: false, detail: `checkpoint failed: ${(error as Error).message}` };
        throw error;
      } finally {
        running = undefined;
      }
    })();
    return running;
  }

  // Joining a flush that began before the caller's write would acknowledge state the
  // snapshot does not contain, so wait that one out before starting the one we need.
  async function barrier(): Promise<void> {
    const inFlight = running;
    if (inFlight) await inFlight.catch(() => {});
    await flush();
  }

  return {
    flush,
    barrier,
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
