import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { randomBytes } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { ArkAddress } from "@arkade-os/sdk";
import { openDb } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { AddressService } from "../src/address-service.js";
import { OwnerSetupService } from "../src/owner-setup-service.js";
import { createServer } from "../src/server.js";
import { decodeOwnerSetup, encodeOwnerSetup, ownerSetupDigest, verifyOwnerSetup, type OwnerSetup } from "../src/enclave/owner-setup.js";

const HOST = "wallet.example";
const ownerKey = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const nextKey = Uint8Array.from({ length: 32 }, (_, i) => i + 40);
const strangerKey = Uint8Array.from({ length: 32 }, (_, i) => i + 80);
const pub = (key: Uint8Array) => bytesToHex(schnorr.getPublicKey(key));
const destination = (n: number) => new ArkAddress(new Uint8Array(32).fill(2), new Uint8Array(32).fill(n), "tark").encode();
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const token = () => randomBytes(32).toString("hex");

const FIRST: OwnerSetup = {
  intent: "set", deployment: "lnurl-test", tenant: HOST, network: "regtest", domain: HOST, username: "alice",
  ownerPublicKey: pub(ownerKey), arkadeDestination: destination(3), claimPublicKey: "02" + "ab".repeat(32), rails: ["arkade", "offline-swap"], revision: 1,
};
const digest = (s: OwnerSetup) => bytesToHex(ownerSetupDigest(s));
const after = (prev: OwnerSetup, change: Partial<OwnerSetup>): OwnerSetup => ({ ...prev, ...change, revision: prev.revision + 1, previousHash: digest(prev) });
const body = (s: OwnerSetup, key = ownerKey, extra: Record<string, unknown> = {}) =>
  ({ payload: b64(encodeOwnerSetup(s)), signature: b64(schnorr.sign(ownerSetupDigest(s), key)), ...extra });

let repos: Repositories; let app: ReturnType<typeof createServer>;
function build(enrollment: boolean) {
  const db = openDb(":memory:"); runMigrations(db); repos = createRepositories(db);
  repos.domains.create({ domain: HOST, allocationModes: ["self"] });
  const addressService = new AddressService(repos, randomBytes(32));
  const ownerSetups = new OwnerSetupService(repos, addressService, { deployment: "lnurl-test", network: "regtest", enrollment: true });
  app = createServer({ port: 0, baseUrl: "http://localhost", minSendable: 1000, maxSendable: 100_000_000 }, {
    repos, addressService, ...(enrollment ? { ownerSetups } : {}),
  });
}
const submit = (b: Record<string, unknown>) => request(app).post("/lnurl/setup").send(b);
const refused = async (b: Record<string, unknown>, status: number, code: string) =>
  expect(await submit(b)).toMatchObject({ status, body: { code } });

describe("the owner-setup routes", () => {
  beforeEach(() => build(true));

  it("enrols, updates and rotates over HTTP, with the real error code for each refusal", async () => {
    const enrolled = await submit(body(FIRST, ownerKey, { token: token() }));
    expect(enrolled).toMatchObject({ status: 200, body: {
      ok: true, applied: true, domain: HOST, username: "alice", revision: 1, digest: digest(FIRST), state: "active", lightningAddress: "alice@wallet.example",
      rails: { requested: ["arkade", "offline-swap"], effective: [
        { id: "offline-swap", available: false, reason: "offline receive is not configured" }, { id: "arkade", available: true },
      ] },
    } });
    expect(enrolled.body.lnurl).toMatch(/^lnurl1/i);
    expect(await submit(body(FIRST, ownerKey, { token: token() }))).toMatchObject({ status: 200, body: { applied: false, revision: 1 } });

    const second = after(FIRST, { arkadeDestination: destination(4) });
    await refused(body(second, strangerKey), 401, "bad_signature");
    await refused(body({ ...second, previousHash: "cd".repeat(32) }), 409, "revision_conflict");
    expect(await submit(body(second))).toMatchObject({ status: 200, body: { applied: true, revision: 2 } });

    const rotation = after(second, { ownerPublicKey: pub(nextKey) });
    await refused(body(rotation), 409, "countersignature_required");
    await refused(body(rotation, ownerKey, { countersignature: b64(schnorr.sign(ownerSetupDigest(rotation), strangerKey)) }), 401, "bad_signature");
    const rotated = await submit(body(rotation, ownerKey, { countersignature: b64(schnorr.sign(ownerSetupDigest(rotation), nextKey)) }));
    expect(rotated).toMatchObject({ status: 200, body: { revision: 3 } });

    await refused(body({ ...FIRST, username: "bob", deployment: "lnurl-other" }, ownerKey, { token: token() }), 403, "wrong_deployment");
    await refused(body({ ...FIRST, username: "bob", network: "bitcoin" }, ownerKey, { token: token() }), 403, "wrong_network");
    await refused(body({ ...FIRST, username: "bob", tenant: "another-provider" }, ownerKey, { token: token() }), 403, "wrong_tenant");
    await refused(body({ ...FIRST, username: "bob", domain: "elsewhere.example" }, ownerKey, { token: token() }), 404, "unknown_domain");
    await refused(body({ ...FIRST, username: "bob", rails: ["interactive-lightning"] }, ownerKey, { token: token() }), 400, "unsupported_rail");
    await refused({ payload: b64(Uint8Array.of(9, 9, 9)), signature: b64(new Uint8Array(64)) }, 400, "invalid_payload");
    await refused({ ...body(FIRST), signature: b64(new Uint8Array(12)) }, 400, "invalid_request");
    await refused({ ...body(FIRST), payload: "not base64url!" }, 400, "invalid_request");
  });

  it("refuses an enrollment token already bound to an address", async () => {
    const legacy = token();
    await request(app).post("/lnurl/address").set("Host", HOST).send({ username: "carol", token: legacy }).expect(201);
    await refused(body(FIRST, ownerKey, { token: legacy }), 409, "stale_credential");
  });

  it("serves the committed payload and signature for offline verification, and the chain from /history", async () => {
    await submit(body(FIRST, ownerKey, { token: token() }));
    const rotation = after(FIRST, { ownerPublicKey: pub(nextKey) });
    await submit(body(rotation, ownerKey, { countersignature: b64(schnorr.sign(ownerSetupDigest(rotation), nextKey)) })).expect(200);

    const served = await request(app).get("/lnurl/setup").query({ domain: HOST, username: "ALICE" });
    expect(served).toMatchObject({ status: 200, body: {
      revision: 2, digest: digest(rotation), previousDigest: digest(FIRST), intent: "rotate", state: "active",
      suspended: false, suspensionReason: null, deployment: "lnurl-test", tenant: HOST, signerPublicKey: pub(ownerKey), ownerPublicKey: pub(nextKey),
    } });
    const payload = Buffer.from(served.body.payload, "base64url");
    const setup = decodeOwnerSetup(payload);
    expect(verifyOwnerSetup(setup, Buffer.from(served.body.signature, "base64url"), hexToBytes(served.body.signerPublicKey))).toBe(true);
    expect(verifyOwnerSetup(setup, Buffer.from(served.body.countersignature, "base64url"), hexToBytes(served.body.ownerPublicKey))).toBe(true);

    const history = await request(app).get("/lnurl/setup/history").query({ domain: HOST, username: "alice", limit: 10 });
    expect(history.body.revisions.map((r: { revision: number; intent: string }) => [r.revision, r.intent])).toEqual([[2, "rotate"], [1, "enroll"]]);
    expect(history.body.revisions[0].previousDigest).toBe(history.body.revisions[1].digest);
    expect((await request(app).get("/lnurl/setup/history").query({ domain: HOST, username: "alice", limit: 1 })).body.revisions).toHaveLength(1);

    expect(await request(app).get("/lnurl/setup").query({ domain: HOST, username: "nobody" })).toMatchObject({ status: 404, body: { code: "unknown_identity" } });
    expect(await request(app).get("/lnurl/setup").query({ domain: HOST })).toMatchObject({ status: 400, body: { code: "invalid_request" } });
  });

  it("limits submissions per identity", async () => {
    const first = body(FIRST, ownerKey, { token: token() });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await submit(first)).status);
    expect(statuses).toEqual([...Array(10).fill(200), 429]);
    expect((await submit(body({ ...FIRST, username: "bob" }, ownerKey, { token: token() }))).status).toBe(200);
  });
});

describe("with enrollment disabled", () => {
  beforeEach(() => build(false));

  it("does not mount the setup routes, nor document them", async () => {
    expect((await submit(body(FIRST, ownerKey, { token: token() }))).status).toBe(404);
    expect((await request(app).get("/lnurl/setup/history").query({ domain: HOST, username: "alice" })).status).toBe(404);
    expect((await request(app).get("/lnurl/setup").query({ domain: HOST, username: "alice" })).body).toEqual({ status: "ERROR", reason: "This LNURL is no longer active" });
    const spec = (await request(app).get("/openapi.json")).body;
    expect(Object.keys(spec.paths).filter((p) => p.startsWith("/lnurl/setup"))).toEqual([]);
  });
});
