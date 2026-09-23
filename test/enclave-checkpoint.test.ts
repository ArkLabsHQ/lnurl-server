import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { initPersistence } from "../src/cli.js";
import type { EnclaveCheckpointConfig } from "../src/config.js";
import { openDb } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { DomainsRepo } from "../src/db/repositories/domains.js";
import { OfflineSwapStore } from "../src/offline-swap-store.js";
import { createCheckpointStore, restoreCheckpoint, sha256 } from "../src/enclave/checkpoint.js";
import type { EnclaveStorage } from "../src/enclave/storage.js";

class MemoryStorage implements EnclaveStorage {
  readonly objects = new Map<string, Uint8Array>();

  async put(key: string, data: Uint8Array): Promise<void> {
    this.objects.set(key, Buffer.from(data));
  }

  async load(key: string): Promise<Uint8Array | undefined> {
    return this.objects.get(key);
  }
}

const SEAL = { key: Buffer.alloc(32, 7), deployment: "lnurl-test" };

const scratchDirs: string[] = [];
afterEach(() => {
  for (const scratch of scratchDirs.splice(0)) rmSync(scratch, { recursive: true, force: true, maxRetries: 2 });
});

/** A checkpoint restores by writing the snapshot to a real path, so `:memory:` is
 *  not available here the way it is for an ordinary open. */
function restorePath(): string {
  const scratch = mkdtempSync(join(tmpdir(), "lnurl-restore-"));
  scratchDirs.push(scratch);
  return join(scratch, "restored.db");
}

function imageOf(db: DatabaseSync): Buffer {
  const target = restorePath();
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  return readFileSync(target);
}

const ACCEPTED_SWAP = {
  paymentHash: "aa".repeat(32),
  pr: "lnbc1accepted",
  sessionId: "offline:1",
  preimage: "bb".repeat(32),
  amountMsat: 5_000_000,
  recovery: {
    version: 1 as const,
    solverName: "primary",
    solverPubkey: "11".repeat(32),
    relays: ["wss://relay.example"],
    rfqId: "22".repeat(32),
    lockupAddress: "tark1lockup",
    expectedAmount: 4_999,
    script: { sender: "33".repeat(32) },
  },
};

class GatedStorage extends MemoryStorage {
  private gate: Promise<void> | undefined;
  private open: (() => void) | undefined;

  hold(): void {
    this.gate = new Promise<void>((resolve) => { this.open = resolve; });
  }

  release(): void {
    this.open?.();
  }

  override async put(key: string, data: Uint8Array): Promise<void> {
    await this.gate;
    await super.put(key, data);
  }
}

/** Down for the first `failures` writes, then healthy — a transient outage. */
class FlakyStorage extends MemoryStorage {
  constructor(private failures: number) { super(); }

  override async put(key: string, data: Uint8Array): Promise<void> {
    if (this.failures-- > 0) throw new Error("enclave storage is down");
    await super.put(key, data);
  }
}

class FailingStorage implements EnclaveStorage {
  async put(): Promise<void> {
    throw new Error("enclave storage is down");
  }

  async load(): Promise<Uint8Array | undefined> {
    return undefined;
  }
}

function countSnapshots(db: DatabaseSync): () => number {
  let n = 0;
  const exec = db.exec.bind(db);
  db.exec = (sql: string) => {
    if (sql.startsWith("VACUUM INTO")) n += 1;
    return exec(sql);
  };
  return () => n;
}

function seedDb(value: number): DatabaseSync {
  const db = openDb(":memory:");
  runMigrations(db);
  db.prepare("INSERT INTO domains (domain, allocation_modes, require_api_key, username_min_len, username_max_len, username_pattern, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    `wallet-${value}.invalid`, "open", 0, 1, 32, "a-z0-9._-", 1, value, value,
  );
  return db;
}

describe("enclave checkpoint store", () => {
  it("snapshots a consistent SQLite image and restores it into the configured database path", async () => {
    const db = seedDb(1);
    const storage = new MemoryStorage();
    const store = createCheckpointStore({ db, storage, prefix: "lnurl/db", seal: SEAL, intervalMs: 1000 });
    const head = await store.flush();
    expect(head).toMatchObject({ digest: expect.stringMatching(/^[0-9a-f]{64}$/), sequence: 1 });

    db.prepare("UPDATE domains SET updated_at = ? WHERE domain = ?").run(2, "wallet-1.invalid");
    const second = await store.flush();
    expect(second?.sequence).toBe(2);
    expect(second?.previousDigest).toBe(head?.ciphertextDigest);
    expect(Array.from(storage.objects.keys()).filter((key) => key.endsWith(".sqlite.br.enc"))).toHaveLength(2);
    await db.close();

    const restoredHead = await restoreCheckpoint({
      dbPath: restorePath(),
      storage,
      prefix: "lnurl/db",
      seal: SEAL,
    });
    expect(restoredHead?.head).toEqual(second);
    expect(restoredHead!.db.prepare("SELECT COUNT(*) AS count FROM domains").get()).toEqual({ count: 1 });
    await restoredHead!.db.close();
  });

  it("refuses a missing or tampered authoritative snapshot", async () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const storage = new MemoryStorage();
    const store = createCheckpointStore({ db, storage, prefix: "lnurl/db", seal: SEAL, intervalMs: 1000 });
    const head = await store.flush();
    await db.close();

    const good = await restoreCheckpoint({ dbPath: restorePath(), storage, prefix: "lnurl/db", seal: SEAL });
    expect(good).toEqual({ db: expect.anything(), head });
    good!.db.close();

    storage.objects.delete(head!.key);
    await expect(restoreCheckpoint({ dbPath: restorePath(), storage, prefix: "lnurl/db", seal: SEAL })).rejects
      .toThrow(/authoritative checkpoint snapshot is missing/);

    storage.objects.set(head!.key, new Uint8Array(64).fill(7));
    await expect(restoreCheckpoint({ dbPath: restorePath(), storage, prefix: "lnurl/db", seal: SEAL })).rejects
      .toThrow(/does not match/);
  });

  it("stores nothing a host could open without the storage key", async () => {
    const db = seedDb(1);
    const storage = new MemoryStorage();
    const store = createCheckpointStore({ db, storage, prefix: "lnurl/db", seal: SEAL, intervalMs: 60_000 });
    const head = await store.flush();
    await db.close();

    const stored = storage.objects.get(head!.key)!;
    let opened = "unreadable";
    try { opened = Buffer.from(brotliDecompressSync(stored)).subarray(0, 15).toString("latin1"); } catch { /* sealed */ }
    expect(opened).not.toBe("SQLite format 3");
  });

  it("refuses a snapshot sealed under another key, or for another deployment", async () => {
    const db = seedDb(1);
    const storage = new MemoryStorage();
    await createCheckpointStore({ db, storage, prefix: "lnurl/db", seal: SEAL, intervalMs: 60_000 }).flush();
    await db.close();

    await expect(restoreCheckpoint({ dbPath: restorePath(), storage, prefix: "lnurl/db", seal: { ...SEAL, key: Buffer.alloc(32, 8) } }))
      .rejects.toThrow(/could not be authenticated/);
    await expect(restoreCheckpoint({ dbPath: restorePath(), storage, prefix: "lnurl/db", seal: { ...SEAL, deployment: "lnurl-other" } }))
      .rejects.toThrow(/could not be authenticated/);
  });

  it("refuses a head whose metadata the host has altered", async () => {
    const db = seedDb(1);
    const storage = new MemoryStorage();
    const head = await createCheckpointStore({ db, storage, prefix: "lnurl/db", seal: SEAL, intervalMs: 60_000 }).flush();
    await db.close();

    const edits = [{ sequence: 7 }, { schemaVersion: 0 }, { epoch: 3 }, { previousDigest: "ab".repeat(32) }, { size: head!.size + 1 }, { digest: "ab".repeat(32) }];
    for (const edit of edits) {
      storage.objects.set("lnurl/db/HEAD.json", Buffer.from(JSON.stringify({ ...head, ...edit })));
      await expect(restoreCheckpoint({ dbPath: restorePath(), storage, prefix: "lnurl/db", seal: SEAL }))
        .rejects.toThrow(/could not be authenticated/);
    }
  });

  it("refuses a database the host fabricated, even behind a consistent head", async () => {
    // Without the key, the best a host can store is a database of its own, packed as
    // an unsealed snapshot would be, under a head that agrees with every byte of it.
    const forged = seedDb(666);
    const image = imageOf(forged);
    await forged.close();
    const stored = brotliCompressSync(image);
    const ciphertextDigest = sha256(stored);
    const head = {
      schema: "lnurl.enclave.checkpoint.v2", prefix: "lnurl/db", sequence: 1, digest: sha256(image), size: image.byteLength,
      ciphertextDigest, key: `lnurl/db/${ciphertextDigest}.sqlite.br.enc`, schemaVersion: 1, epoch: 0, previousDigest: null,
    };
    const storage = new MemoryStorage();
    storage.objects.set(head.key, stored);
    storage.objects.set("lnurl/db/HEAD.json", Buffer.from(JSON.stringify(head)));

    await expect(restoreCheckpoint({ dbPath: restorePath(), storage, prefix: "lnurl/db", seal: SEAL }))
      .rejects.toThrow(/could not be authenticated/);
  });

  it("will not acknowledge a write against a snapshot taken before it", async () => {
    const db = seedDb(1);
    const storage = new GatedStorage();
    const store = createCheckpointStore({ db, storage, prefix: "lnurl/db", seal: SEAL, intervalMs: 60_000 });

    storage.hold();
    const early = store.flush();
    db.prepare("UPDATE domains SET updated_at = ? WHERE domain = ?").run(2, "wallet-1.invalid");
    const durable = store.barrier();
    storage.release();
    await early;
    await durable;
    await db.close();

    const restored = await restoreCheckpoint({ dbPath: restorePath(), storage, prefix: "lnurl/db", seal: SEAL });
    expect(restored!.db.prepare("SELECT updated_at AS u FROM domains").get()).toEqual({ u: 2 });
    await restored!.db.close();
  });

  it("answers a barrier without a snapshot while nothing is uncommitted", async () => {
    const db = seedDb(1);
    const store = createCheckpointStore({ db, storage: new MemoryStorage(), prefix: "lnurl/db", seal: SEAL, intervalMs: 60_000 });
    const snapshots = countSnapshots(db);
    await store.barrier();
    await store.barrier();
    expect(snapshots()).toBe(1);

    db.prepare("UPDATE domains SET updated_at = ? WHERE domain = ?").run(2, "wallet-1.invalid");
    await store.barrier();
    expect(snapshots()).toBe(2);
    await db.close();
  });

  it("joins a flush in flight when its snapshot already covers the caller", async () => {
    const db = seedDb(1);
    const storage = new GatedStorage();
    const store = createCheckpointStore({ db, storage, prefix: "lnurl/db", seal: SEAL, intervalMs: 60_000 });
    const snapshots = countSnapshots(db);

    storage.hold();
    const inFlight = store.flush();
    const durable = store.barrier();
    storage.release();
    await inFlight;
    await durable;
    expect(snapshots()).toBe(1);
    await db.close();
  });

  it("refuses to erase a head another enclave advanced", async () => {
    const db = seedDb(1);
    const storage = new MemoryStorage();
    const mine = createCheckpointStore({ db, storage, prefix: "lnurl/db", seal: SEAL, intervalMs: 60_000 });
    const first = await mine.flush();

    // A second enclave the host started on the same prefix, believing it is starting
    // fresh, does not get to overwrite the head this one committed.
    const theirDb = seedDb(7);
    const theirs = createCheckpointStore({ db: theirDb, storage, prefix: "lnurl/db", seal: SEAL, intervalMs: 60_000 });
    await expect(theirs.flush()).rejects.toThrow(/another writer advanced the checkpoint head/);
    await theirDb.close();
    expect(JSON.parse(Buffer.from(storage.objects.get("lnurl/db/HEAD.json")!).toString()).digest).toBe(first!.digest);

    // And a head that moves underneath a running writer stops that writer too.
    const usurper = {
      schema: "lnurl.enclave.checkpoint.v2", prefix: "lnurl/db", sequence: 9, digest: "cd".repeat(32), size: 4096,
      ciphertextDigest: "ce".repeat(32), key: `lnurl/db/${"ce".repeat(32)}.sqlite.br.enc`,
      schemaVersion: 1, epoch: 0, previousDigest: null,
    };
    storage.objects.set("lnurl/db/HEAD.json", Buffer.from(JSON.stringify(usurper)));
    db.prepare("UPDATE domains SET updated_at = ? WHERE domain = ?").run(2, "wallet-1.invalid");

    await expect(mine.flush()).rejects.toThrow(/another writer advanced the checkpoint head/);
    expect(mine.status()).toMatchObject({ ok: false });
    await db.close();
  });

  it("recovers its head once a storage outage clears", async () => {
    const db = seedDb(1);
    const storage = new FlakyStorage(2);
    const store = createCheckpointStore({ db, storage, prefix: "lnurl/db", seal: SEAL, intervalMs: 60_000 });

    await expect(store.flush()).rejects.toThrow(/storage is down/);
    expect(store.status()).toMatchObject({ ok: false });
    await expect(store.flush()).rejects.toThrow(/storage is down/);

    const head = await store.flush();
    expect(head).toMatchObject({ sequence: 1, previousDigest: null });
    expect(store.status().ok).toBe(true);
    await db.close();
  });

  it("reports its own silence, not just the result of its last attempt", async () => {
    const db = seedDb(1);
    let clock = 1_000_000;
    const store = createCheckpointStore({
      db, storage: new MemoryStorage(), prefix: "lnurl/db", seal: SEAL, intervalMs: 5_000, now: () => clock,
    });
    await store.flush();
    expect(store.status().ok).toBe(true);

    clock += 31_000;
    expect(store.status()).toMatchObject({ ok: false, detail: expect.stringContaining("no checkpoint committed") });

    // An unchanged database is still exactly what is stored, so finding nothing to
    // do counts as durable rather than as another silent interval.
    await store.flush();
    expect(store.status().ok).toBe(true);
    await db.close();
  });

  it("refuses a checkpoint rather than capturing a database mid-transaction", async () => {
    const db = seedDb(1);
    const store = createCheckpointStore({ db, storage: new MemoryStorage(), prefix: "lnurl/db", seal: SEAL, intervalMs: 60_000 });
    db.exec("BEGIN");
    db.prepare("UPDATE domains SET updated_at = ? WHERE domain = ?").run(2, "wallet-1.invalid");

    await expect(store.barrier()).rejects.toThrow(/cannot VACUUM/);
    expect(store.status()).toMatchObject({ ok: false });

    db.exec("ROLLBACK");
    await db.close();
  });

  it("refuses to call state durable when the authority cannot be written", async () => {
    const db = seedDb(1);
    const store = createCheckpointStore({ db, storage: new FailingStorage(), prefix: "lnurl/db", seal: SEAL, intervalMs: 60_000 });
    await expect(store.barrier()).rejects.toThrow(/storage is down/);
    expect(store.status()).toMatchObject({ ok: false, detail: expect.stringContaining("checkpoint failed") });
    await db.close();
  });

  it("refuses a replayed older head when the administrator pinned the current one", async () => {
    const db = seedDb(1);
    const storage = new MemoryStorage();
    const store = createCheckpointStore({ db, storage, prefix: "lnurl/db", seal: SEAL, intervalMs: 60_000 });
    const first = await store.flush();
    db.prepare("UPDATE domains SET updated_at = ? WHERE domain = ?").run(2, "wallet-1.invalid");
    const second = await store.flush();
    await db.close();

    // The host keeps every snapshot, so it can re-advertise a head it prefers.
    storage.objects.set("lnurl/db/HEAD.json", Buffer.from(JSON.stringify(first)));

    await expect(restoreCheckpoint({ dbPath: restorePath(), storage, prefix: "lnurl/db", seal: SEAL, expectedDigest: second!.ciphertextDigest }))
      .rejects.toThrow(/is not the pinned head/);

    // Unpinned, the same replay is accepted — which is the exposure the pin closes.
    const rolledBack = await restoreCheckpoint({ dbPath: restorePath(), storage, prefix: "lnurl/db", seal: SEAL });
    expect(rolledBack!.db.prepare("SELECT updated_at AS u FROM domains").get()).toEqual({ u: 1 });
    await rolledBack!.db.close();
  });

  it("holds a sequence floor across a crash, where no digest is known in advance", async () => {
    const db = seedDb(1);
    const storage = new MemoryStorage();
    const store = createCheckpointStore({ db, storage, prefix: "lnurl/db", seal: SEAL, intervalMs: 60_000 });
    const first = await store.flush();
    db.prepare("UPDATE domains SET updated_at = ? WHERE domain = ?").run(2, "wallet-1.invalid");
    await store.flush();
    await db.close();

    const restored = await restoreCheckpoint({ dbPath: restorePath(), storage, prefix: "lnurl/db", seal: SEAL, minSequence: 2 });
    expect(restored!.head.sequence).toBe(2);
    await restored!.db.close();

    storage.objects.set("lnurl/db/HEAD.json", Buffer.from(JSON.stringify(first)));
    await expect(restoreCheckpoint({ dbPath: restorePath(), storage, prefix: "lnurl/db", seal: SEAL, minSequence: 2 }))
      .rejects.toThrow(/behind the pinned floor/);
  });

  it("refuses to boot on a pinned head the host does not serve", async () => {
    await expect(restoreCheckpoint({
      dbPath: restorePath(), storage: new MemoryStorage(), prefix: "lnurl/db", seal: SEAL, expectedDigest: "ab".repeat(32),
    })).rejects.toThrow(/pinned but the host served none/);
  });

  it("refuses genesis and a bad prefix", async () => {
    const storage = new MemoryStorage();
    await expect(restoreCheckpoint({ dbPath: restorePath(), storage, prefix: "lnurl/db", seal: SEAL })).resolves.toBeUndefined();
    expect(() => createCheckpointStore({ db: openDb(":memory:"), storage, prefix: "../bad", seal: SEAL, intervalMs: 1000 }))
      .toThrow(/invalid ENCLAVE_CHECKPOINT_KEY/);
  });
});

describe("initPersistence under enclave checkpoints", () => {
  let dir: string | undefined;

  afterEach(() => {
    // A failing case leaves the database open, and Windows will not unlink under that.
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
    dir = undefined;
  });

  function checkpointConfig(overrides: Partial<EnclaveCheckpointConfig> = {}): EnclaveCheckpointConfig {
    return {
      enabled: true,
      s3Bucket: "lnurl-checkpoints",
      awsRegion: "us-east-1",
      allowGenesis: false,
      checkpointIntervalMs: 1_000,
      checkpointKey: "lnurl/db",
      deployment: SEAL.deployment,
      storageKey: SEAL.key,
      ...overrides,
    };
  }

  it("refuses to boot without an authoritative head unless genesis is allowed", async () => {
    dir = mkdtempSync(join(tmpdir(), "lnurl-enclave-"));
    await expect(initPersistence({ dbPath: join(dir, "state", "lnurl.db"), checkpoint: checkpointConfig(), storage: new MemoryStorage() }))
      .rejects.toThrow(/authoritative checkpoint head is missing/);
  });

  it("refuses to checkpoint without anywhere to put the checkpoints", async () => {
    dir = mkdtempSync(join(tmpdir(), "lnurl-enclave-"));
    await expect(initPersistence({ dbPath: join(dir, "state", "lnurl.db"), checkpoint: checkpointConfig({ allowGenesis: true }) }))
      .rejects.toThrow(/no checkpoint storage was supplied/);
  });

  it("recovers an accepted swap when the enclave is destroyed and only the checkpoint survives", async () => {
    dir = mkdtempSync(join(tmpdir(), "lnurl-enclave-"));
    const storage = new MemoryStorage();
    const first = await initPersistence({
      dbPath: join(dir, "boot-a", "lnurl.db"),
      checkpoint: checkpointConfig({ allowGenesis: true }),
      storage,
    });
    const store = createCheckpointStore({
      db: first!.db,
      storage,
      prefix: "lnurl/db",
      seal: SEAL,
      intervalMs: 60_000,
      head: first!.checkpointHead,
    });
    new OfflineSwapStore(first!.db, 3_600_000).createAccepted(ACCEPTED_SWAP);
    await store.barrier();

    // The enclave dies: RAM-backed state goes with it, leaving only remote objects.
    first!.db.close();
    rmSync(join(dir, "boot-a"), { recursive: true, force: true });

    const restarted = await initPersistence({
      dbPath: join(dir, "boot-b", "lnurl.db"),
      checkpoint: checkpointConfig(),
      storage,
    });
    expect(new OfflineSwapStore(restarted!.db, 3_600_000).listPending()).toEqual([
      expect.objectContaining({ paymentHash: ACCEPTED_SWAP.paymentHash, preimage: ACCEPTED_SWAP.preimage }),
    ]);
    restarted!.db.close();
  });

  it("commits a first head on an explicit genesis, then boots the next enclave from it", async () => {
    dir = mkdtempSync(join(tmpdir(), "lnurl-enclave-"));
    const storage = new MemoryStorage();

    // Nested paths that no test fixture creates: the enclave makes its own state directory.
    const genesis = await initPersistence({
      dbPath: join(dir, "state", "lnurl.db"),
      bootstrapDomain: "domain.com",
      checkpoint: checkpointConfig({ allowGenesis: true }),
      storage,
    });
    expect(genesis?.checkpointHead).toMatchObject({ sequence: 1, previousDigest: null });
    expect(storage.objects.has("lnurl/db/HEAD.json")).toBe(true);
    genesis!.db.close();

    // A restarted enclave gets a fresh RAM-backed path and no genesis permission.
    const restored = await initPersistence({
      dbPath: join(dir, "restarted", "lnurl.db"),
      checkpoint: checkpointConfig(),
      storage,
    });
    expect(restored?.checkpointHead).toEqual(genesis?.checkpointHead);
    expect(new DomainsRepo(restored!.db).getByDomain("domain.com")?.domain).toBe("domain.com");
    restored!.db.close();
  });
});
