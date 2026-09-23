import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { createAuthorityClient } from "../../src/enclave/authority-client.js";
import type { CommitPayload } from "../../src/enclave/authority-wire.js";
import { createCheckpointStore, headFromWire, restoreCheckpoint } from "../../src/enclave/checkpoint.js";
import type { EnclaveStorage } from "../../src/enclave/storage.js";

const DEPLOYMENT = "lnurl-interop";
const SEAL = { key: Buffer.alloc(32, 9), deployment: DEPLOYMENT };
const scratch = mkdtempSync(join(tmpdir(), "lnurl-authority-interop-"));
const devserver = join(scratch, process.platform === "win32" ? "devserver.exe" : "devserver");
const children: ChildProcess[] = [];

beforeAll(() => {
  execFileSync("go", ["build", "-o", devserver, "./cmd/devserver"], { cwd: fileURLToPath(new URL("../../authority", import.meta.url)) });
});
afterAll(async () => {
  await Promise.all(children.map((child) => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill();
  })));
  // Windows can hold a killed binary's image a moment after it exits.
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

class MemoryStorage implements EnclaveStorage {
  readonly objects = new Map<string, Uint8Array>();
  async put(key: string, data: Uint8Array): Promise<void> {
    this.objects.set(key, Buffer.from(data));
  }
  async load(key: string): Promise<Uint8Array | undefined> {
    return this.objects.get(key);
  }
}

/** A Go authority whose only deployment has this key as its active writer, at epoch 1. */
async function authorityFor(writerPublicKey: Uint8Array) {
  const child = spawn(devserver, ["-deployment", DEPLOYMENT, "-seed-writer", Buffer.from(writerPublicKey).toString("hex")]);
  children.push(child);
  const line = await new Promise<string>((resolve, reject) => {
    createInterface({ input: child.stdout! }).once("line", resolve);
    child.once("exit", (code) => reject(new Error(`devserver exited with ${code}`)));
  });
  const { url, spki } = JSON.parse(line) as { url: string; spki: string };
  return { url, client: createAuthorityClient({ url, deployment: DEPLOYMENT, publicKeys: [Buffer.from(spki, "base64")], timeoutMs: 5_000 }) };
}

function writer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { privateKey, raw: Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url") };
}

function seeded() {
  const db = openDb(":memory:");
  runMigrations(db);
  db.prepare("INSERT INTO domains (domain, allocation_modes, require_api_key, username_min_len, username_max_len, username_pattern, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("interop.invalid", "open", 0, 1, 32, "a-z0-9._-", 1, 1, 1);
  return db;
}

describe("the TypeScript enclave against the Go authority", () => {
  it("commits sealed checkpoints, then restores from the authority's signed statement", async () => {
    const w = writer();
    const { client } = await authorityFor(w.raw);
    const db = seeded();
    const storage = new MemoryStorage();
    const store = createCheckpointStore({
      db, storage, prefix: "lnurl/db", seal: SEAL, intervalMs: 60_000,
      authority: { client, deployment: DEPLOYMENT, epoch: 1, writer: w.privateKey, writerPublicKey: w.raw },
    });
    await store.flush();
    db.prepare("UPDATE domains SET updated_at = ? WHERE domain = ?").run(2, "interop.invalid");
    const second = (await store.flush())!;
    db.close();

    const st = await client.state(randomBytes(16));
    expect(st).toMatchObject({ sequence: 2, activeEpoch: 1, head: { ciphertextDigest: second.ciphertextDigest, sealEpoch: 1 } });
    const restored = await restoreCheckpoint({
      dbPath: join(mkdtempSync(join(scratch, "restore-")), "db.sqlite"), storage, prefix: "lnurl/db", seal: SEAL, authorityHead: headFromWire(st.head!),
    });
    expect(restored!.db.prepare("SELECT updated_at AS u FROM domains").get()).toEqual({ u: 2 });
    restored!.db.close();
  });

  it("answers a replayed commit with what it committed, and refuses the id reused", async () => {
    const w = writer();
    const { client } = await authorityFor(w.raw);
    const head = (tag: string, sequence: number, previousDigest: string | null) => ({
      schema: "lnurl.enclave.checkpoint.v2", prefix: "lnurl/db", schemaVersion: 12, sealEpoch: 1, sequence, previousDigest,
      digest: "d4".repeat(32), size: 4096, ciphertextDigest: tag.repeat(32), key: `lnurl/db/${tag.repeat(32)}.sqlite.br.enc`,
    });
    const m: CommitPayload = { deployment: DEPLOYMENT, epoch: 1, operationId: "0f".repeat(16), expectedSequence: 0, priorDigest: null, head: head("c3", 1, null) };
    await client.commit(m, w.privateKey);
    expect(await client.commit(m, w.privateKey)).toMatchObject({ sequence: 1, currentOperationId: m.operationId });

    const reused = { ...m, expectedSequence: 1, priorDigest: "c3".repeat(32), head: head("c4", 2, "c3".repeat(32)) };
    await expect(client.commit(reused, w.privateKey)).rejects.toMatchObject({ code: "operation_reused", current: { sequence: 1 } });
  });

  it("fences the writer when a successor activates, and the store stops for good", async () => {
    const w = writer();
    const { url, client } = await authorityFor(w.raw);
    const db = seeded();
    const stops: Error[] = [];
    const store = createCheckpointStore({
      db, storage: new MemoryStorage(), prefix: "lnurl/db", seal: SEAL, intervalMs: 60_000, onTerminal: (e) => stops.push(e),
      authority: { client, deployment: DEPLOYMENT, epoch: 1, writer: w.privateKey, writerPublicKey: w.raw },
    });
    await store.flush();
    expect((await fetch(`${url}/dev/fence`, { method: "POST" })).status).toBe(204);

    db.prepare("UPDATE domains SET updated_at = ? WHERE domain = ?").run(2, "interop.invalid");
    await expect(store.barrier()).rejects.toMatchObject({ code: "writer_fenced", current: { activeEpoch: 2 } });
    expect(stops).toHaveLength(1);
    db.close();
  });
});
