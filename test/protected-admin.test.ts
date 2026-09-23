import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { randomBytes } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ArkAddress } from "@arkade-os/sdk";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { AddressService } from "../src/address-service.js";
import { OwnerSetupService } from "../src/owner-setup-service.js";
import { SessionManager } from "../src/session-manager.js";
import { SettingsService } from "../src/settings.js";
import { createAdminApi } from "../src/admin-api.js";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { encodeOwnerSetup, ownerSetupDigest, type OwnerSetup } from "../src/enclave/owner-setup.js";

const HOST = "wallet.example";
const ownerKey = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const SETUP: OwnerSetup = {
  intent: "set", deployment: "lnurl-test", tenant: HOST, network: "regtest", domain: HOST, username: "alice",
  ownerPublicKey: bytesToHex(schnorr.getPublicKey(ownerKey)),
  arkadeDestination: new ArkAddress(new Uint8Array(32).fill(2), new Uint8Array(32).fill(3), "tark").encode(),
  claimPublicKey: "02" + "ab".repeat(32), rails: ["offline-swap", "arkade"], revision: 1,
};
const DIGEST = bytesToHex(ownerSetupDigest(SETUP));

let db: Db; let repos: Repositories; let admin: express.Express; let publicApp: express.Express;
let domainId: number; let aliceId: number; let legacyId: number;

beforeEach(() => {
  db = openDb(":memory:"); runMigrations(db); repos = createRepositories(db);
  domainId = repos.domains.create({ domain: HOST, allocationModes: ["self"] }).id;
  const addressService = new AddressService(repos, randomBytes(32));
  const owners = new OwnerSetupService(repos, addressService, { deployment: "lnurl-test", network: "regtest", enrollment: true });
  aliceId = owners.submit({
    payload: encodeOwnerSetup(SETUP), signature: schnorr.sign(ownerSetupDigest(SETUP), ownerKey), token: randomBytes(32).toString("hex"),
  }).identity.addressId!;
  legacyId = repos.addresses.create({ domainId, username: "carol", status: "active", sessionId: "sess-carol" }).id;

  const config = loadConfig({ PORT: "3000", BASE_URL: "http://localhost:3000" });
  const settings = new SettingsService(repos.settings, {
    minSendable: config.minSendable, maxSendable: config.maxSendable, invoiceTimeoutMs: config.invoiceTimeoutMs,
    baseUrl: config.baseUrl, registrationRateLimitPerMin: config.registrationRateLimitPerMin,
  });
  admin = express(); admin.use(express.json());
  admin.use("/admin/api", createAdminApi({ repos, addressService, sessions: new SessionManager(), settings, config }));
  publicApp = createServer({ port: 0, baseUrl: "http://localhost", minSendable: 1000, maxSendable: 100_000_000 }, { repos });
});

const signedHead = () => {
  const i = repos.ownerSetups.identity(HOST, "alice")!;
  return { currentRevision: i.currentRevision, currentDigest: i.currentDigest, owner: bytesToHex(i.ownerPublicKey) };
};
const HEAD = { currentRevision: 1, currentDigest: DIGEST, owner: SETUP.ownerPublicKey };

describe("admin writes on a protected address", () => {
  it("refuses admin rails, status and delete, leaving the signed setup as it was", async () => {
    const rails = await request(admin).patch(`/admin/api/addresses/${aliceId}/rails`).send({ disabledRails: ["arkade"] });
    expect(rails).toMatchObject({ status: 409, body: { code: "protected_address" } });
    const status = await request(admin).patch(`/admin/api/addresses/${aliceId}`).send({ status: "revoked" });
    expect(status).toMatchObject({ status: 409, body: { code: "protected_address" } });
    expect(status.body.error).toContain("/suspend");
    expect(await request(admin).delete(`/admin/api/addresses/${aliceId}`)).toMatchObject({ status: 409, body: { code: "protected_address" } });

    expect(repos.addresses.getById(aliceId)).toMatchObject({ status: "active", disabledRails: ["interactive-lightning", "covenant", "onchain"] });
    expect(signedHead()).toEqual(HEAD);
  });

  it("refuses to reserve or mint a tombstoned username", async () => {
    repos.addresses.delete(aliceId);
    for (const mode of ["reserve", "mint"]) {
      const out = await request(admin).post("/admin/api/addresses").send({ domain: HOST, username: "alice", mode });
      expect(out).toMatchObject({ status: 409, body: { code: "protected_address" } });
    }
  });

  it("refuses deleting a domain that holds identities, and changing its tenant", async () => {
    expect(await request(admin).delete(`/admin/api/domains/${domainId}`)).toMatchObject({ status: 409, body: { code: "protected_address" } });
    expect(repos.domains.getById(domainId)).toBeDefined();

    const retenant = await request(admin).patch(`/admin/api/domains/${domainId}`).send({ tenant: "another-provider" });
    expect(retenant).toMatchObject({ status: 400, body: { code: "tenant_fixed" } });
    const same = await request(admin).patch(`/admin/api/domains/${domainId}`).send({ tenant: HOST, maxPerSession: 3 });
    expect(same).toMatchObject({ status: 200, body: { tenant: HOST, maxPerSession: 3 } });
  });

  it("suspends without touching the signed setup, and lifts it the same way", async () => {
    const suspended = await request(admin).post(`/admin/api/addresses/${aliceId}/suspend`).send({ suspended: true, reason: "chargeback review" });
    expect(suspended).toMatchObject({ status: 200, body: { suspended: true, suspensionReason: "chargeback review", currentRevision: 1, currentDigest: DIGEST } });
    expect(signedHead()).toEqual(HEAD);
    expect((await request(publicApp).get("/.well-known/lnurlp/alice").set("Host", HOST)).body)
      .toEqual({ status: "ERROR", reason: "alice@wallet.example is suspended by its provider" });

    const listed = await request(admin).get("/admin/api/addresses");
    expect(listed.body.find((a: { id: number }) => a.id === aliceId)).toMatchObject({ protected: true, suspended: true, suspensionReason: "chargeback review" });
    expect(listed.body.find((a: { id: number }) => a.id === legacyId)).toMatchObject({ protected: false, suspended: false });

    const lifted = await request(admin).post(`/admin/api/addresses/${aliceId}/suspend`).send({ suspended: false });
    expect(lifted).toMatchObject({ status: 200, body: { suspended: false, suspensionReason: null } });
    expect((await request(publicApp).get("/.well-known/lnurlp/alice").set("Host", HOST)).body).toMatchObject({ tag: "payRequest" });
  });

  it("suspends only protected addresses, and only with a reason", async () => {
    expect(await request(admin).post(`/admin/api/addresses/${aliceId}/suspend`).send({ suspended: true })).toMatchObject({ status: 400 });
    expect(await request(admin).post(`/admin/api/addresses/${aliceId}/suspend`).send({ suspended: "yes", reason: "x" })).toMatchObject({ status: 400 });
    expect(await request(admin).post(`/admin/api/addresses/${legacyId}/suspend`).send({ suspended: true, reason: "x" }))
      .toMatchObject({ status: 409, body: { code: "not_protected" } });
    expect(await request(admin).post("/admin/api/addresses/9999/suspend").send({ suspended: true, reason: "x" })).toMatchObject({ status: 404 });
  });

  it("leaves a legacy address to the operator", async () => {
    expect((await request(admin).patch(`/admin/api/addresses/${legacyId}/rails`).send({ disabledRails: ["arkade"] })).status).toBe(200);
    expect((await request(admin).patch(`/admin/api/addresses/${legacyId}`).send({ status: "revoked" })).status).toBe(200);
    expect((await request(admin).delete(`/admin/api/addresses/${legacyId}`)).status).toBe(200);
  });
});
