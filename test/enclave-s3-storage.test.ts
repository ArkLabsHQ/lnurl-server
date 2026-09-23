import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { openDb } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createCheckpointStore, restoreCheckpoint } from "../src/enclave/checkpoint.js";
import { S3Storage } from "../src/enclave/s3-storage.js";

const BUCKET = "lnurl-checkpoints";
const SEAL = { key: Buffer.alloc(32, 7), deployment: "lnurl-test" };

let server: Server | undefined;
const dirs: string[] = [];
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
});

/** Enough of S3's path-style REST API for PutObject and GetObject. */
async function fakeS3(behaviour: "ok" | "fail" | "hang" = "ok") {
  const objects = new Map<string, Buffer>();
  const paths: string[] = [];
  server = createServer((req, res) => {
    if (behaviour === "hang") return;
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://s3").pathname);
    paths.push(`${req.method} ${path}`);
    if (behaviour === "fail") {
      res.writeHead(500, { "content-type": "application/xml" })
        .end("<Error><Code>InternalError</Code><Message>storage is down</Message></Error>");
      return;
    }
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => { objects.set(path, Buffer.concat(chunks)); res.writeHead(200, { etag: '"x"' }).end(); });
      return;
    }
    const value = objects.get(path);
    if (!value) {
      res.writeHead(404, { "content-type": "application/xml" })
        .end("<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>");
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": value.length }).end(value);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  const client = new S3Client({
    endpoint: `http://127.0.0.1:${port}`,
    forcePathStyle: true,
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    maxAttempts: 1,
  });
  return { client, objects, paths };
}

describe("S3 checkpoint storage", () => {
  it("round-trips binary objects under path-style keys", async () => {
    const { client, objects, paths } = await fakeS3();
    const storage = new S3Storage({ client, bucket: BUCKET });
    const data = randomBytes(4096);

    await storage.put("lnurl/db/HEAD.json", data);
    expect(objects.get(`/${BUCKET}/lnurl/db/HEAD.json`)).toEqual(data);
    await expect(storage.load("lnurl/db/HEAD.json")).resolves.toEqual(new Uint8Array(data));
    expect(paths).toEqual([`PUT /${BUCKET}/lnurl/db/HEAD.json`, `GET /${BUCKET}/lnurl/db/HEAD.json`]);
  });

  it("answers a missing object with nothing rather than an error", async () => {
    const { client } = await fakeS3();
    await expect(new S3Storage({ client, bucket: BUCKET }).load("lnurl/db/HEAD.json")).resolves.toBeUndefined();
  });

  it("surfaces a storage failure instead of reporting success", async () => {
    const { client } = await fakeS3("fail");
    await expect(new S3Storage({ client, bucket: BUCKET }).put("lnurl/db/x", new Uint8Array([1])))
      .rejects.toThrow(/enclave storage PUT lnurl\/db\/x/);
  });

  it("gives up on a store that accepts the connection and never answers", async () => {
    const { client } = await fakeS3("hang");
    await expect(new S3Storage({ client, bucket: BUCKET, timeoutMs: 200 }).load("lnurl/db/HEAD.json"))
      .rejects.toThrow(/timed out after 200ms/);
  });

  it("carries a sealed checkpoint through the real SDK and restores it", async () => {
    const { client, objects } = await fakeS3();
    const storage = new S3Storage({ client, bucket: BUCKET });
    const db = openDb(":memory:");
    runMigrations(db);
    db.prepare("INSERT INTO domains (domain, allocation_modes, require_api_key, username_min_len, username_max_len, username_pattern, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("wallet.invalid", "open", 0, 1, 32, "a-z0-9._-", 1, 1, 1);

    const head = await createCheckpointStore({ db, storage, prefix: "lnurl/db", seal: SEAL, intervalMs: 60_000 }).flush();
    await db.close();
    expect(objects.has(`/${BUCKET}/${head!.key}`)).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), "lnurl-s3-"));
    dirs.push(dir);
    const restored = await restoreCheckpoint({ dbPath: join(dir, "state.db"), storage, prefix: "lnurl/db", seal: SEAL });
    expect(restored!.head).toEqual(head);
    expect(restored!.db.prepare("SELECT domain FROM domains").get()).toEqual({ domain: "wallet.invalid" });
    restored!.db.close();
  });
});
