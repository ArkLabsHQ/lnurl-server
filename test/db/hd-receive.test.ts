import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { createBase58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { openDb, type Db } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { createRepositories } from "../../src/db/repositories/index.js";
import { validateHdReceive } from "../../src/hd-receive.js";

const payload = Buffer.alloc(78, 1);
payload.writeUInt32BE(0x043587cf, 0);
payload[4] = 4;
payload.set(secp256k1.getPublicKey(new Uint8Array(32).fill(1)), 45);
const codec = createBase58check(sha256);
const config = (bytes = payload, origin = "12345678/86'/1'/0'/0") => validateHdReceive({
  version: 1, descriptor: `tr([${origin}]${codec.encode(bytes)}/*)`,
  serverPubKey: Buffer.from(secp256k1.getPublicKey(new Uint8Array(32).fill(2))).subarray(1).toString("hex"),
  hrp: "tark", exitDelay: { type: "seconds", value: 512 },
});
const dbs: Db[] = [];
const paths: string[] = [];
function setup(path = ":memory:") {
  const db = openDb(path);
  dbs.push(db);
  runMigrations(db);
  const repos = createRepositories(db);
  const domain = repos.domains.create({ domain: "test.example", allocationModes: ["self"] });
  const address = repos.addresses.create({ domainId: domain.id, username: "alice", status: "active" });
  return { db, repos, address };
}
afterEach(() => {
  for (const db of dbs.splice(0)) { try { db.close(); } catch {} }
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("durable HD receive allocations", () => {
  it("keeps legacy receive data through migration and replaces all static destinations on opt-in", () => {
    const db = openDb(":memory:");
    dbs.push(db);
    runMigrations(db, { upToVersion: 25 });
    const repos = createRepositories(db);
    const domain = repos.domains.create({ domain: "test.example", allocationModes: ["self"] });
    db.prepare("INSERT INTO addresses (domain_id,username,status,arkade_address,claim_public_key,boarding_address,created_at,updated_at) VALUES (?,'alice','active','static','key','boarding',1,1)").run(domain.id);
    runMigrations(db);
    const address = repos.addresses.getByDomainAndUsername(domain.id, "alice")!;
    expect(address).toMatchObject({ arkadeAddress: "static", claimPublicKey: "key", boardingAddress: "boarding", hdReceive: null });
    repos.addresses.setHdReceive(address.id, config());
    expect(repos.addresses.getById(address.id)).toMatchObject({ arkadeAddress: null, claimPublicKey: null, boardingAddress: null, hdReceive: config() });
    expect(() => repos.addresses.setOfflineReceive(address.id, "static", "key")).toThrow();
    expect(() => repos.addresses.setBoardingAddress(address.id, "boarding")).toThrow();
  });

  it("persists abandoned reservations and allocates monotonically across independent connections and restart", async () => {
    const path = mkdtempSync(join(tmpdir(), "lnurl-hd-"));
    paths.push(path);
    const { repos, address } = setup(join(path, "db.sqlite"));
    repos.addresses.setHdReceive(address.id, config());
    const secondDb = openDb(join(path, "db.sqlite"));
    dbs.push(secondDb);
    const second = createRepositories(secondDb);
    const allocations = await Promise.all(Array.from({ length: 12 }, (_, i) => Promise.resolve().then(() => (i % 2 ? repos : second).hdReceive.allocate(address.id, config()))));
    expect(allocations.map((a) => a.index)).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(new Set(allocations.map((a) => a.arkadeAddress)).size).toBe(12);
    const reopenedDb = openDb(join(path, "db.sqlite"));
    dbs.push(reopenedDb);
    const reopened = createRepositories(reopenedDb);
    expect(reopened.hdReceive.allocate(address.id, config()).index).toBe(12);
    expect(reopened.hdReceive.list(address.id, allocations[9].id, 2)).toEqual(allocations.slice(10));
  });

  it("never resets a branch counter for aliases, metadata edits, rotation or delete and re-register", () => {
    const { repos, address } = setup();
    repos.addresses.setHdReceive(address.id, config());
    expect(repos.hdReceive.allocate(address.id, config()).index).toBe(0);
    const alias = repos.addresses.create({ domainId: address.domainId, username: "alias", status: "active" });
    const changed = Buffer.from(payload);
    changed.fill(3, 5, 13);
    const sameBranch = config(changed, "abcdef01/86'/1'/7'/0");
    repos.addresses.setHdReceive(alias.id, sameBranch);
    expect(repos.hdReceive.allocate(alias.id, sameBranch).index).toBe(1);
    changed[13] ^= 1;
    const rotated = config(changed);
    repos.addresses.setHdReceive(address.id, rotated);
    expect(repos.hdReceive.allocate(address.id, rotated).index).toBe(0);
    repos.addresses.setHdReceive(address.id, config());
    expect(repos.hdReceive.allocate(address.id, config()).index).toBe(2);
    expect(repos.hdReceive.list(address.id, 0, 100).map((a) => a.hd)).toEqual([config(), rotated, config()]);
    repos.addresses.delete(address.id);
    const again = repos.addresses.create({ domainId: alias.domainId, username: "alice", status: "active" });
    repos.addresses.setHdReceive(again.id, config());
    expect(repos.hdReceive.allocate(again.id, config()).index).toBe(3);
  });

  it("serializes genuinely concurrent allocation transactions on separate threads", async () => {
    const path = mkdtempSync(join(tmpdir(), "lnurl-hd-concurrent-"));
    paths.push(path);
    const { repos, address } = setup(join(path, "db.sqlite"));
    repos.addresses.setHdReceive(address.id, config());
    const source = `
      const { parentPort, workerData } = require('node:worker_threads');
      try {
        const { require: tsRequire } = require(workerData.tsx);
        const { openDb } = tsRequire(workerData.connection, workerData.parent);
        const { createRepositories } = tsRequire(workerData.repositories, workerData.parent);
        const db = openDb(workerData.path);
        db.exec('PRAGMA busy_timeout = 10000');
        const repos = createRepositories(db);
        parentPort.postMessage({ ready: true });
        parentPort.once('message', () => {
          try {
            parentPort.postMessage({ results: Array.from({ length: 6 }, () => repos.hdReceive.allocate(workerData.id, workerData.hd)) });
          } catch (error) { parentPort.postMessage({ error: error.message }); }
          finally { db.close(); parentPort.close(); }
        });
      } catch (error) { parentPort.postMessage({ error: error.message }); parentPort.close(); }
    `;
    const workerData = {
      tsx: join(process.cwd(), "node_modules/tsx/dist/cjs/api/index.cjs"),
      parent: import.meta.url,
      connection: new URL("../../src/db/connection.ts", import.meta.url).href,
      repositories: new URL("../../src/db/repositories/index.ts", import.meta.url).href,
      path: join(path, "db.sqlite"), id: address.id, hd: config(),
    };
    const workers = Array.from({ length: 2 }, () => new Worker(source, { eval: true, workerData }));
    try {
      const results = workers.map((worker) => new Promise<{ index: number; arkadeAddress: string }[]>((resolve, reject) => {
        worker.on("error", reject);
        worker.on("message", (message) => {
          if (message.error) reject(new Error(message.error));
          if (message.results) resolve(message.results);
        });
      }));
      await Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => {
        worker.on("error", reject);
        worker.on("message", (message) => { if (message.ready) resolve(); else if (message.error) reject(new Error(message.error)); });
      })));
      workers.forEach((worker) => worker.postMessage("allocate"));
      const allocations = (await Promise.all(results)).flat();
      expect(allocations.map((a) => a.index).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i));
      expect(new Set(allocations.map((a) => a.arkadeAddress)).size).toBe(12);
      expect(repos.hdReceive.allocate(address.id, config()).index).toBe(12);
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  }, 60_000);

  it("fails closed for stale registration, revocation and corrupt counters without reusing an address", () => {
    const { db, repos, address } = setup();
    repos.addresses.setHdReceive(address.id, config());
    const first = repos.hdReceive.allocate(address.id, config());
    const changed = { ...config(), exitDelay: { type: "blocks" as const, value: 144 } };
    repos.addresses.setHdReceive(address.id, changed);
    expect(() => repos.hdReceive.allocate(address.id, config())).toThrow();
    expect(repos.hdReceive.allocate(address.id, changed).index).toBe(1);
    repos.addresses.updateStatus(address.id, "revoked");
    expect(() => repos.hdReceive.allocate(address.id, changed)).toThrow();
    repos.addresses.updateStatus(address.id, "active");
    db.exec("UPDATE hd_receive_sources SET next_index = 0");
    expect(() => repos.hdReceive.allocate(address.id, changed)).toThrow();
    expect(repos.hdReceive.list(address.id, 0, 100)[0]).toEqual(first);
    db.exec("UPDATE hd_receive_sources SET next_index = 2147483648");
    expect(() => repos.hdReceive.allocate(address.id, changed)).toThrow();
    db.prepare("UPDATE addresses SET hd_receive = ? WHERE id = ?").run('{"version":2}', address.id);
    expect(() => repos.hdReceive.allocate(address.id, changed)).toThrow();
  });

  it("rolls back failed persistence before returning a destination", () => {
    const { db, repos, address } = setup();
    repos.addresses.setHdReceive(address.id, config());
    db.exec("CREATE TRIGGER reject_allocation BEFORE INSERT ON hd_receive_allocations BEGIN SELECT RAISE(ABORT, 'write failed'); END");
    expect(() => repos.hdReceive.allocate(address.id, config())).toThrow("write failed");
    expect(repos.hdReceive.list(address.id, 0, 100)).toEqual([]);
    db.exec("DROP TRIGGER reject_allocation");
    expect(repos.hdReceive.allocate(address.id, config()).index).toBe(0);
  });

  it.each(["offline", "boarding"])("blocks a racing static %s update after HD opt-in", (rail) => {
    const { db, repos, address } = setup();
    const prepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      if (sql.startsWith(rail === "offline" ? "UPDATE addresses SET arkade_address" : "UPDATE addresses SET boarding_address")) {
        db.prepare = prepare;
        repos.addresses.setHdReceive(address.id, config());
      }
      return prepare(sql);
    };
    try {
      expect(() => rail === "offline" ? repos.addresses.setOfflineReceive(address.id, "static", "key") : repos.addresses.setBoardingAddress(address.id, "boarding")).toThrow();
      expect(repos.addresses.getById(address.id)).toMatchObject({ hdReceive: config(), arkadeAddress: null, claimPublicKey: null, boardingAddress: null });
    } finally { db.prepare = prepare; }
  });
});
