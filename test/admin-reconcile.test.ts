import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { randomBytes } from "node:crypto";
import { hex } from "@scure/base";
import { ArkAddress, MultisigTapscript, VtxoScript } from "@arkade-os/sdk";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { AddressService } from "../src/address-service.js";
import { SessionManager } from "../src/session-manager.js";
import { createAdminApi } from "../src/admin-api.js";
import { loadConfig } from "../src/config.js";
import { SettingsService } from "../src/settings.js";
import { DbSettlementStore } from "../src/settlement-store.js";

const xonly = (f: number) => secp256k1.getPublicKey(new Uint8Array(32).fill(f), true).subarray(1);
const ARK = new VtxoScript([MultisigTapscript.encode({ pubkeys: [xonly(9), xonly(3)] }).script])
  .address("ark", xonly(3)).encode();
const CLAIMPK = "02" + "ab".repeat(32);
const SCRIPT = hex.encode(ArkAddress.decode(ARK).pkScript);

let db: Db; let repos: Repositories; let app: express.Express; let domainId: number;
let settlements: DbSettlementStore; let arrivals: { txid: string; vout: number; value: number; createdAt: Date; script: string }[];

const vtxo = (txid: string, value: number) => ({ txid, vout: 0, value, createdAt: new Date(), script: SCRIPT });

beforeEach(() => {
  db = openDb(":memory:"); runMigrations(db); repos = createRepositories(db);
  settlements = new DbSettlementStore(db, 86_400_000);
  const config = loadConfig({ PORT: "3000", BASE_URL: "http://localhost:3000" });
  const settings = new SettingsService(repos.settings, {
    minSendable: config.minSendable, maxSendable: config.maxSendable, invoiceTimeoutMs: config.invoiceTimeoutMs,
    baseUrl: config.baseUrl, registrationRateLimitPerMin: config.registrationRateLimitPerMin,
  });
  arrivals = [];
  app = express(); app.use(express.json());
  app.use("/admin/api", createAdminApi({
    repos, addressService: new AddressService(repos, randomBytes(32)), sessions: new SessionManager(),
    settings, config, settlements,
    indexer: { getVtxos: async () => ({ vtxos: arrivals }) } as never,
  }));
  domainId = repos.domains.create({ domain: "domain.com", allocationModes: ["self"] }).id;
});

function addr(username = "alice") {
  const a = repos.addresses.create({ domainId, username, status: "active", sessionId: "s" });
  repos.addresses.setOfflineReceive(a.id, ARK, CLAIMPK);
  return a;
}

describe("admin reconcile", () => {
  // The support case: the record expired, so verify says "not found" and the
  // address history is blank, but the payment did arrive and the money is the
  // user's. Nothing else in the service can answer "did it land?" after that.
  it("reports an arrival no settlement record accounts for", async () => {
    const a = addr();
    arrivals = [vtxo("aa".repeat(32), 5_000)];
    const res = await request(app).get(`/admin/api/addresses/${a.id}/reconcile`);
    expect(res.status).toBe(200);
    expect(res.body.arkadeAddress).toBe(ARK);
    expect(res.body.unattributed).toBe(1);
    expect(res.body.arrivals[0]).toMatchObject({ txid: "aa".repeat(32), value: 5_000, attributed: false });
  });

  it("marks an arrival the service already settled", async () => {
    const a = addr();
    settlements.create({
      paymentHash: "vid-1", pr: "", sessionId: "s", addressId: a.id,
      paymentOption: "arkade", paymentDestination: ARK, amountMsat: 5_000_000,
    });
    settlements.markObserved("vid-1", "bb".repeat(32));
    arrivals = [vtxo("bb".repeat(32), 5_000)];
    const res = await request(app).get(`/admin/api/addresses/${a.id}/reconcile`);
    expect(res.body.unattributed).toBe(0);
    expect(res.body.arrivals[0]).toMatchObject({ attributed: true, paymentHash: "vid-1" });
  });

  it("404s an unknown address", async () => {
    expect((await request(app).get("/admin/api/addresses/9999/reconcile")).status).toBe(404);
  });

  it("refuses an address with no registered Arkade identity", async () => {
    const bare = repos.addresses.create({ domainId, username: "bare", status: "active", sessionId: "s" });
    const res = await request(app).get(`/admin/api/addresses/${bare.id}/reconcile`);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/Arkade/i);
  });

  // Read-only on purpose: re-attributing a lapsed payment from an address shared
  // by every payment to it would be guesswork, and this exists to inform a human.
  it("changes nothing it reports on", async () => {
    const a = addr();
    arrivals = [vtxo("cc".repeat(32), 5_000)];
    await request(app).get(`/admin/api/addresses/${a.id}/reconcile`);
    expect(settlements.listByAddress(a.id, 10)).toHaveLength(0);
  });
});
