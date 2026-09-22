import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initPersistence } from "../src/cli.js";
import type { EnclaveCheckpointConfig } from "../src/config.js";
import { openDb } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { DomainsRepo } from "../src/db/repositories/domains.js";
import { OfflineSwapStore } from "../src/offline-swap-store.js";
import { createCheckpointStore, restoreCheckpoint } from "../src/enclave/checkpoint.js";
import { EnclaveStorageClient, type EnclaveStorage } from "../src/enclave/storage.js";

class MemoryStorage implements EnclaveStorage {
  readonly objects = new Map<string, Uint8Array>();

  async put(key: string, data: Uint8Array): Promise<void> {
    this.objects.set(key, Buffer.from(data));
  }

  async load(key: string): Promise<Uint8Array | undefined> {
    return this.objects.get(key);
  }
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

class FailingStorage implements EnclaveStorage {
  async put(): Promise<void> {
    throw new Error("enclave storage is down");
  }

  async load(): Promise<Uint8Array | undefined> {
    return undefined;
  }
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
  it("serializes a consistent SQLite snapshot and restores it into the configured database path", async () => {
    const db = seedDb(1);
    const storage = new MemoryStorage();
    const store = createCheckpointStore({ db, storage, prefix: "lnurl/db", intervalMs: 1000 });
    const head = await store.flush();
    expect(head).toMatchObject({ digest: expect.stringMatching(/^[0-9a-f]{64}$/), sequence: 1 });

    db.prepare("UPDATE domains SET updated_at = ? WHERE domain = ?").run(2, "wallet-1.invalid");
    const second = await store.flush();
    expect(second?.sequence).toBe(2);
    expect(second?.previousDigest).toBe(head?.digest);
    expect(Array.from(storage.objects.keys()).filter((key) => key.endsWith(".sqlite"))).toHaveLength(2);
    await db.close();

    const restoredHead = await restoreCheckpoint({
      dbPath: ":memory:",
      storage,
      prefix: "lnurl/db",
    });
    expect(restoredHead?.head).toEqual(second);
    expect(restoredHead!.db.prepare("SELECT COUNT(*) AS count FROM domains").get()).toEqual({ count: 1 });
    await restoredHead!.db.close();
  });

  it("refuses a missing or tampered authoritative snapshot", async () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const storage = new MemoryStorage();
    const store = createCheckpointStore({ db, storage, prefix: "lnurl/db", intervalMs: 1000 });
    const head = await store.flush();
    await db.close();

    await expect(restoreCheckpoint({ dbPath: ":memory:", storage, prefix: "lnurl/db" })).resolves
      .toEqual({ db: expect.anything(), head });
    storage.objects.delete(head!.key);
    await expect(restoreCheckpoint({ dbPath: ":memory:", storage, prefix: "lnurl/db" })).rejects
      .toThrow(/authoritative checkpoint snapshot is missing/);

    storage.objects.set(head!.key, new Uint8Array(64).fill(7));
    await expect(restoreCheckpoint({ dbPath: ":memory:", storage, prefix: "lnurl/db" })).rejects
      .toThrow(/does not match/);
  });

  it("will not acknowledge a write against a snapshot taken before it", async () => {
    const db = seedDb(1);
    const storage = new GatedStorage();
    const store = createCheckpointStore({ db, storage, prefix: "lnurl/db", intervalMs: 60_000 });

    storage.hold();
    const early = store.flush();
    db.prepare("UPDATE domains SET updated_at = ? WHERE domain = ?").run(2, "wallet-1.invalid");
    const durable = store.barrier();
    storage.release();
    await early;
    await durable;
    await db.close();

    const restored = await restoreCheckpoint({ dbPath: ":memory:", storage, prefix: "lnurl/db" });
    expect(restored!.db.prepare("SELECT updated_at AS u FROM domains").get()).toEqual({ u: 2 });
    await restored!.db.close();
  });

  it("refuses to call state durable when the authority cannot be written", async () => {
    const db = seedDb(1);
    const store = createCheckpointStore({ db, storage: new FailingStorage(), prefix: "lnurl/db", intervalMs: 60_000 });
    await expect(store.barrier()).rejects.toThrow(/storage is down/);
    expect(store.status()).toMatchObject({ ok: false, detail: expect.stringContaining("checkpoint failed") });
    await db.close();
  });

  it("refuses a replayed older head when the administrator pinned the current one", async () => {
    const db = seedDb(1);
    const storage = new MemoryStorage();
    const store = createCheckpointStore({ db, storage, prefix: "lnurl/db", intervalMs: 60_000 });
    const first = await store.flush();
    db.prepare("UPDATE domains SET updated_at = ? WHERE domain = ?").run(2, "wallet-1.invalid");
    const second = await store.flush();
    await db.close();

    // The host keeps every snapshot, so it can re-advertise a head it prefers.
    storage.objects.set("lnurl/db/HEAD.json", Buffer.from(JSON.stringify(first)));

    await expect(restoreCheckpoint({ dbPath: ":memory:", storage, prefix: "lnurl/db", expectedDigest: second!.digest }))
      .rejects.toThrow(/is not the pinned head/);

    // Unpinned, the same replay is accepted — which is the exposure the pin closes.
    const rolledBack = await restoreCheckpoint({ dbPath: ":memory:", storage, prefix: "lnurl/db" });
    expect(rolledBack!.db.prepare("SELECT updated_at AS u FROM domains").get()).toEqual({ u: 1 });
    await rolledBack!.db.close();
  });

  it("holds a sequence floor across a crash, where no digest is known in advance", async () => {
    const db = seedDb(1);
    const storage = new MemoryStorage();
    const store = createCheckpointStore({ db, storage, prefix: "lnurl/db", intervalMs: 60_000 });
    const first = await store.flush();
    db.prepare("UPDATE domains SET updated_at = ? WHERE domain = ?").run(2, "wallet-1.invalid");
    await store.flush();
    await db.close();

    const restored = await restoreCheckpoint({ dbPath: ":memory:", storage, prefix: "lnurl/db", minSequence: 2 });
    expect(restored!.head.sequence).toBe(2);
    await restored!.db.close();

    storage.objects.set("lnurl/db/HEAD.json", Buffer.from(JSON.stringify(first)));
    await expect(restoreCheckpoint({ dbPath: ":memory:", storage, prefix: "lnurl/db", minSequence: 2 }))
      .rejects.toThrow(/behind the pinned floor/);
  });

  it("refuses to boot on a pinned head the host does not serve", async () => {
    await expect(restoreCheckpoint({
      dbPath: ":memory:", storage: new MemoryStorage(), prefix: "lnurl/db", expectedDigest: "ab".repeat(32),
    })).rejects.toThrow(/pinned but the host served none/);
  });

  it("refuses genesis and a bad prefix", async () => {
    const storage = new MemoryStorage();
    await expect(restoreCheckpoint({ dbPath: ":memory:", storage, prefix: "lnurl/db" })).resolves.toBeUndefined();
    expect(() => createCheckpointStore({ db: openDb(":memory:"), storage, prefix: "../bad", intervalMs: 1000 }))
      .toThrow(/invalid ENCLAVE_CHECKPOINT_KEY/);
  });
});

describe("initPersistence under enclave checkpoints", () => {
  let dir: string | undefined;
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
    // A failing case leaves the database open, and Windows will not unlink under that.
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
    dir = undefined;
  });

  async function startStorage(): Promise<{ baseUrl: string; objects: Map<string, Uint8Array> }> {
    const objects = new Map<string, Uint8Array>();
    server = createServer((req, res) => {
      if (req.headers.authorization !== "Bearer token") { res.writeHead(401).end(); return; }
      const key = (req.url ?? "").replace(/^\/v1\/storage\//, "").split("/").map(decodeURIComponent).join("/");
      if (req.method === "PUT") {
        const chunks: Uint8Array[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(new Uint8Array(chunk)));
        req.on("end", () => { objects.set(key, Buffer.concat(chunks)); res.writeHead(201).end(); });
        return;
      }
      const value = objects.get(key);
      if (!value) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": "application/octet-stream" }).end(value);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no local address");
    return { baseUrl: `http://127.0.0.1:${address.port}`, objects };
  }

  function checkpointConfig(baseUrl: string, overrides: Partial<EnclaveCheckpointConfig> = {}): EnclaveCheckpointConfig {
    return {
      enabled: true,
      storageUrl: baseUrl,
      storageToken: "token",
      allowGenesis: false,
      checkpointIntervalMs: 1_000,
      checkpointKey: "lnurl/db",
      ...overrides,
    };
  }

  it("refuses to boot without an authoritative head unless genesis is allowed", async () => {
    dir = mkdtempSync(join(tmpdir(), "lnurl-enclave-"));
    const { baseUrl } = await startStorage();
    await expect(initPersistence({ dbPath: join(dir, "state", "lnurl.db"), checkpoint: checkpointConfig(baseUrl) }))
      .rejects.toThrow(/authoritative checkpoint head is missing/);
  });

  it("recovers an accepted swap when the enclave is destroyed and only the checkpoint survives", async () => {
    dir = mkdtempSync(join(tmpdir(), "lnurl-enclave-"));
    const { baseUrl } = await startStorage();
    const first = await initPersistence({
      dbPath: join(dir, "boot-a", "lnurl.db"),
      checkpoint: checkpointConfig(baseUrl, { allowGenesis: true }),
    });
    const store = createCheckpointStore({
      db: first!.db,
      storage: new EnclaveStorageClient({ baseUrl, token: "token" }),
      prefix: "lnurl/db",
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
      checkpoint: checkpointConfig(baseUrl),
    });
    expect(new OfflineSwapStore(restarted!.db, 3_600_000).listPending()).toEqual([
      expect.objectContaining({ paymentHash: ACCEPTED_SWAP.paymentHash, preimage: ACCEPTED_SWAP.preimage }),
    ]);
    restarted!.db.close();
  });

  it("commits a first head on an explicit genesis, then boots the next enclave from it", async () => {
    dir = mkdtempSync(join(tmpdir(), "lnurl-enclave-"));
    const { baseUrl, objects } = await startStorage();

    // Nested paths that no test fixture creates: the enclave makes its own state directory.
    const genesis = await initPersistence({
      dbPath: join(dir, "state", "lnurl.db"),
      bootstrapDomain: "domain.com",
      checkpoint: checkpointConfig(baseUrl, { allowGenesis: true }),
    });
    expect(genesis?.checkpointHead).toMatchObject({ sequence: 1, previousDigest: null });
    expect(objects.has("lnurl/db/HEAD.json")).toBe(true);
    genesis!.db.close();

    // A restarted enclave gets a fresh RAM-backed path and no genesis permission.
    const restored = await initPersistence({
      dbPath: join(dir, "restarted", "lnurl.db"),
      checkpoint: checkpointConfig(baseUrl),
    });
    expect(restored?.checkpointHead).toEqual(genesis?.checkpointHead);
    expect(new DomainsRepo(restored!.db).getByDomain("domain.com")?.domain).toBe("domain.com");
    restored!.db.close();
  });
});

describe("enclave storage client", () => {
  it("uses the authenticated runtime API", async () => {
    const server = createServer((req, res) => {
      if (req.headers.authorization !== "Bearer token") {
        res.writeHead(401).end();
        return;
      }
      if (req.method === "PUT" && req.url === "/v1/storage/lnurl/db/HEAD.json") {
        const chunks: Uint8Array[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(new Uint8Array(chunk)));
        req.on("end", () => {
          storage.objects.set("lnurl/db/HEAD.json", Buffer.concat(chunks));
          res.writeHead(201).end(JSON.stringify({ status: "stored" }));
        });
        return;
      }
      if (req.method === "GET" && req.url === "/v1/storage/lnurl/db/HEAD.json") {
        const value = storage.objects.get("lnurl/db/HEAD.json");
        if (!value) { res.writeHead(404).end(); return; }
        res.writeHead(200, { "content-type": "application/octet-stream" }).end(value);
        return;
      }
      res.writeHead(404).end();
    });
    const storage = new MemoryStorage();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no local address");
    const client = new EnclaveStorageClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "token",
    });
    const data = Buffer.from("snapshot", "utf8");
    await client.put("lnurl/db/HEAD.json", data);
    await expect(client.load("lnurl/db/HEAD.json")).resolves.toEqual(new Uint8Array(data));
    await expect(client.load("missing/key")).resolves.toBeUndefined();
    server.close();
  });
});
