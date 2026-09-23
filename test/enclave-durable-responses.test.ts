import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import request from "supertest";
import { ArkAddress } from "@arkade-os/sdk";
import { createServer } from "../src/server.js";
import { createAdminServer } from "../src/admin-server.js";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { AddressService } from "../src/address-service.js";
import { SessionManager } from "../src/session-manager.js";
import { SettingsService } from "../src/settings.js";
import { loadConfig } from "../src/config.js";
import { encryptToken } from "../src/crypto.js";
import { deriveSessionId } from "../src/session-id.js";
import { createCheckpointStore, restoreCheckpoint, type CheckpointStore } from "../src/enclave/checkpoint.js";
import type { EnclaveStorage } from "../src/enclave/storage.js";
import type { LnurlServiceConfig } from "../src/types.js";

const KEY = randomBytes(32);
const SEAL = { key: Buffer.alloc(32, 7), deployment: "lnurl-test" };
const TOKEN = "cd".repeat(32);
const RECEIVE = new ArkAddress(new Uint8Array(32), new Uint8Array(32), "tark").encode();
const IDENTITY = { arkadeAddress: RECEIVE, claimPublicKey: "02" + "ab".repeat(32) };
const CONFIG: LnurlServiceConfig = { port: 0, baseUrl: "http://localhost", minSendable: 1000, maxSendable: 100_000_000, invoiceTimeoutMs: 3000 };

/** Can be taken down, or made to park writes so a test can look before they land. */
class Storage implements EnclaveStorage {
  readonly objects = new Map<string, Uint8Array>();
  down = false;
  writes = 0;
  private parked: Promise<void> | undefined;
  private unpark: (() => void) | undefined;

  hold(): void {
    this.parked = new Promise<void>((resolve) => { this.unpark = resolve; });
  }

  release(): void {
    this.unpark?.();
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    this.writes += 1;
    await this.parked;
    if (this.down) throw new Error("enclave storage is down");
    this.objects.set(key, Buffer.from(data));
  }

  async load(key: string): Promise<Uint8Array | undefined> {
    if (this.down) throw new Error("enclave storage is down");
    return this.objects.get(key);
  }
}

let db: Db; let repos: Repositories; let storage: Storage; let store: CheckpointStore;
let app: ReturnType<typeof createServer>; let addressId: number;
const scratch: string[] = [];

beforeEach(async () => {
  db = openDb(":memory:"); runMigrations(db); repos = createRepositories(db);
  const domainId = repos.domains.create({ domain: "domain.com", allocationModes: ["self"] }).id;
  addressId = repos.addresses.create({
    domainId, username: "off", status: "active", sessionId: deriveSessionId(TOKEN), encryptedToken: encryptToken(TOKEN, KEY),
  }).id;
  storage = new Storage();
  store = createCheckpointStore({ db, storage, prefix: "lnurl/db", seal: SEAL, intervalMs: 60_000 });
  await store.flush();
  app = createServer(CONFIG, { repos, addressService: new AddressService(repos, KEY), durability: store });
});
afterEach(() => {
  db.close();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const setup = () =>
  request(app).post("/lnurl/address/off/arkade").set("Host", "domain.com").set("Authorization", `Bearer ${TOKEN}`).send(IDENTITY);

/** What a fresh enclave would boot with. */
async function committedIdentity(): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), "lnurl-gate-"));
  scratch.push(dir);
  const restored = await restoreCheckpoint({ dbPath: join(dir, "restored.db"), storage, prefix: "lnurl/db", seal: SEAL });
  const row = restored!.db.prepare("SELECT arkade_address AS a FROM addresses WHERE id = ?").get(addressId) as { a: string | null };
  restored!.db.close();
  return row.a;
}

describe("durable responses", () => {
  it("answers a setup change only once it is durable", async () => {
    storage.hold();
    const before = storage.writes;
    let answered = false;
    const pending = setup().then((res) => { answered = true; return res; });
    while (!answered && storage.writes === before) await new Promise((r) => setTimeout(r, 5));
    expect(answered).toBe(false);

    storage.release();
    expect((await pending).status).toBe(200);
    expect(await committedIdentity()).toBe(RECEIVE);
  });

  it("refuses to acknowledge a setup change it cannot make durable", async () => {
    storage.down = true;
    const refused = await setup();
    expect(refused.status).toBe(503);
    expect(refused.body).toMatchObject({ status: "ERROR" });

    storage.down = false;
    expect((await setup()).status).toBe(200);
    expect(await committedIdentity()).toBe(RECEIVE);
  });

  it("does not serve a read of state that is not yet durable", async () => {
    // Written by no request, as a background worker's change would be.
    repos.addresses.setOfflineReceive(addressId, RECEIVE, IDENTITY.claimPublicKey);
    storage.down = true;
    expect((await request(app).get("/.well-known/lnurlp/off").set("Host", "domain.com")).status).toBe(503);
  });

  it("serves a read without touching storage while nothing is uncommitted", async () => {
    const writes = storage.writes;
    expect((await request(app).get("/.well-known/lnurlp/off").set("Host", "domain.com")).status).toBe(200);
    expect(storage.writes).toBe(writes);
  });

  it("keeps health answering while checkpoints fail", async () => {
    repos.addresses.setOfflineReceive(addressId, RECEIVE, IDENTITY.claimPublicKey);
    storage.down = true;
    expect((await request(app).get("/livez")).body).toEqual({ status: "live" });
    expect((await request(app).get("/readyz")).body).toHaveProperty("components");
  });

  it("opens an event stream while checkpoints fail", async () => {
    repos.addresses.setOfflineReceive(addressId, RECEIVE, IDENTITY.claimPublicKey);
    storage.down = true;
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const { port } = server.address() as { port: number };
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      http.request({ host: "127.0.0.1", port, path: "/lnurl/session", method: "POST", headers: { "Content-Type": "application/json" } }, resolve)
        .on("error", reject)
        .end("{}");
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    res.destroy();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it("holds the admin API to the same rule", async () => {
    const config = loadConfig({ PORT: "3000", BASE_URL: "http://localhost:3000" });
    const settings = new SettingsService(repos.settings, {
      minSendable: config.minSendable, maxSendable: config.maxSendable, invoiceTimeoutMs: config.invoiceTimeoutMs,
      baseUrl: config.baseUrl, registrationRateLimitPerMin: config.registrationRateLimitPerMin,
    });
    const admin = createAdminServer({
      repos, addressService: new AddressService(repos, KEY), sessions: new SessionManager(), settings, config, durability: store,
    });
    storage.down = true;
    expect((await request(admin).post("/admin/api/domains").send({ domain: "new.com", allocationModes: ["self"] })).status).toBe(503);
  });
});
