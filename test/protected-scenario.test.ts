import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import express from "express";
import request from "supertest";
import { randomBytes } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ArkAddress } from "@arkade-os/sdk";
import { openDb } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { AddressService } from "../src/address-service.js";
import { OwnerSetupService } from "../src/owner-setup-service.js";
import { SessionManager } from "../src/session-manager.js";
import { SettingsService } from "../src/settings.js";
import { MemorySettlementStore } from "../src/settlement-store.js";
import { createAdminApi } from "../src/admin-api.js";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { deriveSessionId } from "../src/session-id.js";
import { encodeOwnerSetup, ownerSetupDigest, type OwnerSetup } from "../src/enclave/owner-setup.js";

const HOST = "wallet.example";
const keyA = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const keyB = Uint8Array.from({ length: 32 }, (_, i) => i + 40);
const pub = (key: Uint8Array) => bytesToHex(schnorr.getPublicKey(key));
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const token = () => randomBytes(32).toString("hex");
const DESTINATION = new ArkAddress(new Uint8Array(32).fill(2), new Uint8Array(32).fill(3), "tark").encode();
const FIRST: OwnerSetup = {
  intent: "set", deployment: "lnurl-test", tenant: HOST, network: "regtest", domain: HOST, username: "alice",
  ownerPublicKey: pub(keyA), arkadeDestination: DESTINATION, claimPublicKey: "02" + "ab".repeat(32), rails: ["arkade"], revision: 1,
};
const after = (prev: OwnerSetup, change: Partial<OwnerSetup> = {}): OwnerSetup =>
  ({ ...prev, ...change, revision: prev.revision + 1, previousHash: bytesToHex(ownerSetupDigest(prev)) });
const signed = (s: OwnerSetup, key: Uint8Array, extra: Record<string, unknown> = {}) =>
  ({ payload: b64(encodeOwnerSetup(s)), signature: b64(schnorr.sign(ownerSetupDigest(s), key)), ...extra });

let repos: Repositories; let server: http.Server; let baseUrl: string; let admin: express.Express;

beforeAll(async () => {
  const db = openDb(":memory:"); runMigrations(db); repos = createRepositories(db);
  repos.domains.create({ domain: HOST, allocationModes: ["self"] });
  repos.domains.create({ domain: "other.example", tenant: "other-provider", allocationModes: ["self"] });
  const addressService = new AddressService(repos, randomBytes(32));
  const sessions = new SessionManager();
  server = http.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  server.on("request", createServer({ port: 0, baseUrl, minSendable: 1000, maxSendable: 100_000_000 }, {
    repos, addressService, sessions, settlements: new MemorySettlementStore(86_400_000),
    ownerSetups: new OwnerSetupService(repos, addressService, { deployment: "lnurl-test", network: "regtest", enrollment: true }),
  }));
  const config = loadConfig({ PORT: "3000", BASE_URL: "http://localhost:3000" });
  const settings = new SettingsService(repos.settings, {
    minSendable: config.minSendable, maxSendable: config.maxSendable, invoiceTimeoutMs: config.invoiceTimeoutMs,
    baseUrl: config.baseUrl, registrationRateLimitPerMin: config.registrationRateLimitPerMin,
  });
  admin = express(); admin.use(express.json());
  admin.use("/admin/api", createAdminApi({ repos, addressService, sessions, settings, config }));
});
afterAll(async () => { await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }); });

/** An SSE answer resolves on its status line, so an accepted session cannot hang the test. */
function send(method: string, path: string, opts: { body?: unknown; bearer?: string } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${path}`, {
      method, headers: { Host: HOST, "Content-Type": "application/json", ...(opts.bearer ? { Authorization: `Bearer ${opts.bearer}` } : {}) },
    }, (res) => {
      if (res.headers["content-type"]?.startsWith("text/event-stream")) { resolve({ status: res.statusCode!, body: {} }); res.destroy(); return; }
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode!, body: data ? JSON.parse(data) : {} }));
    });
    req.on("error", reject);
    req.end(opts.body === undefined ? undefined : JSON.stringify(opts.body));
  });
}
const setupFor = (body: Record<string, unknown>) => send("POST", "/lnurl/setup", { body });
const aliceId = () => repos.ownerSetups.identity(HOST, "alice")!.addressId;
const payArkade = () => send("GET", "/.well-known/lnurlp/alice/callback?amount=50000&paymentOption=arkade");

describe("the design's delivery step 3, against one server in order", () => {
  it("holds a protected address against every listed attack", async () => {
    const t1 = token();
    expect(await setupFor(signed(FIRST, keyA, { token: t1 }))).toMatchObject({ status: 200, body: { revision: 1 } });

    // Cross-tenant refusal.
    const foreign = { ...FIRST, domain: "other.example", username: "mallory" };
    expect(await setupFor(signed(foreign, keyA, { token: token() }))).toMatchObject({ status: 403, body: { code: "wrong_tenant" } });
    const otherId = repos.domains.getByDomain("other.example")!.id;
    expect(await request(admin).patch(`/admin/api/domains/${otherId}`).send({ tenant: HOST })).toMatchObject({ status: 400, body: { code: "tenant_fixed" } });

    // Legacy enrollment labelling.
    const legacy = token();
    expect((await send("POST", "/lnurl/address", { body: { username: "carol", token: legacy } })).status).toBe(201);
    expect(await setupFor(signed({ ...FIRST, username: "dave" }, keyA, { token: legacy }))).toMatchObject({ status: 409, body: { code: "stale_credential" } });
    expect(await setupFor(signed({ ...FIRST, username: "carol" }, keyA, { token: token() }))).toMatchObject({ status: 409, body: { code: "username_taken" } });
    const listed = (await request(admin).get("/admin/api/addresses")).body as { username: string; protected: boolean }[];
    expect(Object.fromEntries(listed.map((a) => [a.username, a.protected]))).toEqual({ alice: true, carol: false });

    // The destination and claim key, through admin and bearer routes.
    expect((await request(admin).patch(`/admin/api/addresses/${aliceId()}/rails`).send({ disabledRails: ["arkade"] })).status).toBe(409);
    expect((await request(admin).patch(`/admin/api/addresses/${aliceId()}`).send({ status: "revoked" })).status).toBe(409);
    expect((await request(admin).delete(`/admin/api/addresses/${aliceId()}`)).status).toBe(409);
    expect((await request(admin).delete(`/admin/api/domains/${repos.domains.getByDomain(HOST)!.id}`)).status).toBe(409);
    const repoint = { arkadeAddress: new ArkAddress(new Uint8Array(32).fill(2), new Uint8Array(32).fill(9), "tark").encode(), claimPublicKey: "02" + "ee".repeat(32) };
    expect(await send("POST", "/lnurl/address/alice/arkade", { body: repoint, bearer: t1 })).toMatchObject({ status: 409, body: { code: "protected_address" } });
    expect((await payArkade()).body).toMatchObject({ status: "OK", paymentDestination: DESTINATION });

    // Key rotation.
    const rotation = after(FIRST, { ownerPublicKey: pub(keyB) });
    expect((await setupFor(signed(rotation, keyA, { countersignature: b64(schnorr.sign(ownerSetupDigest(rotation), keyB)) }))).status).toBe(200);
    const update = after(rotation, { rails: ["arkade", "onchain"], boardingAddress: "tb1qowner" });
    expect(await setupFor(signed(update, keyA))).toMatchObject({ status: 401, body: { code: "bad_signature" } });
    expect(await setupFor(signed(update, keyB))).toMatchObject({ status: 200, body: { revision: 3 } });

    // Ownership tombstone: every route refuses the row's deletion, so only the store can lose it.
    repos.addresses.delete(aliceId()!);
    expect(await send("POST", "/lnurl/address", { body: { username: "alice", token: token() } })).toMatchObject({ status: 409, body: { code: "protected_address" } });
    expect((await request(admin).post("/admin/api/addresses").send({ domain: HOST, username: "alice", mode: "mint" })).status).toBe(409);
    expect((await send("GET", "/.well-known/lnurlp/alice")).body).toEqual({ status: "ERROR", reason: "Unknown LN address" });
    const t2 = token();
    expect(await setupFor(signed(after(update), keyB, { token: t2 }))).toMatchObject({ status: 200, body: { revision: 4 } });
    expect((await payArkade()).body).toMatchObject({ status: "OK", paymentDestination: DESTINATION });

    // A known token opening a live session and posting a substituted invoice.
    const known = deriveSessionId(t2);
    expect((await send("POST", "/lnurl/session", { body: { token: t2 } })).status).toBe(409);
    expect((await send("POST", `/lnurl/session/${known}/invoice`, { body: { pr: "lnbc1substituted" }, bearer: t2 })).status).toBe(401);
    expect((await send("POST", `/lnurl/session/${known}/settled`, { body: { preimage: "00".repeat(32) }, bearer: t2 })).status).toBe(401);
    expect((await send("POST", "/lnurl/session", { body: { token: legacy } })).status).toBe(200);
    expect((await payArkade()).body).toMatchObject({ status: "OK", paymentDestination: DESTINATION });
    expect((await send("GET", "/lnurl/setup?domain=wallet.example&username=alice")).body).toMatchObject({ revision: 4, ownerPublicKey: pub(keyB), state: "active" });
  });
});
