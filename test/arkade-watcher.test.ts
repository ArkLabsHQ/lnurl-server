import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { hex } from "@scure/base";
import { ArkAddress, RestIndexerProvider } from "@arkade-os/sdk";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { settleDestinationPayments, SETTLEMENT_SKEW_MS } from "../src/arkade-watcher.js";
import { MemorySettlementStore } from "../src/settlement-store.js";
import { createServer } from "../src/server.js";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import type { LnurlServiceConfig } from "../src/types.js";

// The watcher against a fake Arkade indexer over real HTTP (repo style). The wire
// vtxo shape mirrors the indexer's (amount in string-sats, createdAt in string-secs).

const CONFIG: LnurlServiceConfig = { port: 0, baseUrl: "", minSendable: 1000, maxSendable: 100_000_000, invoiceTimeoutMs: 3000 };
const DEST = new ArkAddress(secp256k1.utils.randomSecretKey(), secp256k1.utils.randomSecretKey(), "tark").encode();
const DEST_SCRIPT = hex.encode(ArkAddress.decode(DEST).pkScript);

function wireVtxo(opts: { txid: string; valueSat: number; createdAtSec: number; script?: string }) {
  return {
    outpoint: { txid: opts.txid, vout: 0 },
    amount: String(opts.valueSat),
    createdAt: String(opts.createdAtSec),
    script: opts.script ?? DEST_SCRIPT,
    isSpent: false,
    isSwept: false,
    isPreconfirmed: true,
    commitmentTxids: [],
    spentBy: "",
    settledBy: "",
    arkTxid: opts.txid,
    isUnrolled: false,
    expiresAt: String(Math.floor(Date.now() / 1000) + 86400),
  };
}

/** Queryable fake: returns the vtxos registered for a `scripts` match. */
let indexerVtxos: ReturnType<typeof wireVtxo>[];
let indexerFails: boolean;
let indexerCtx: { baseUrl: string; close: () => Promise<void> };

beforeAll(async () => {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    const url = new URL(req.url ?? "", "http://x");
    if (url.pathname === "/v1/indexer/vtxos" && !indexerFails) {
      const scripts = url.searchParams.getAll("scripts");
      const vtxos = indexerVtxos.filter((v) => scripts.includes(v.script));
      res.end(JSON.stringify({ vtxos, page: { current: 1, next: 1, total: 1 } }));
      return;
    }
    res.statusCode = indexerFails ? 500 : 404;
    res.end("{}");
  });
  indexerCtx = await new Promise<typeof indexerCtx>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = (server as http.Server).address() as { port: number };
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) });
    });
  });
});
afterAll(() => indexerCtx.close());
beforeEach(() => {
  indexerVtxos = [];
  indexerFails = false;
});

function storeWith(...recs: { hash: string; amountMsat: number; createdAt?: number }[]): MemorySettlementStore {
  const s = new MemorySettlementStore(3_600_000);
  const now = Date.now();
  for (const r of recs) {
    s.create({ paymentHash: r.hash, pr: "", sessionId: "sess", paymentOption: "arkade", paymentDestination: DEST, amountMsat: r.amountMsat });
    // createdAt is stamped from the store clock at create; backdate via a wrapped store when needed
    if (r.createdAt !== undefined) {
      const rec = s.get(r.hash)!;
      rec.createdAt = r.createdAt;
    }
  }
  void now;
  return s;
}

describe("settleDestinationPayments", () => {
  it("flips a record when a covering payment is observed, with the txid as reference", async () => {
    const store = storeWith({ hash: "v1", amountMsat: 50_000 });
    const createdAt = store.get("v1")!.createdAt;
    indexerVtxos.push(wireVtxo({ txid: randomBytes(32).toString("hex"), valueSat: 50, createdAtSec: Math.floor(createdAt / 1000) }));

    const n = await settleDestinationPayments(store, new RestIndexerProvider(indexerCtx.baseUrl));

    expect(n).toBe(1);
    expect(store.get("v1")).toMatchObject({ settled: true, paymentReference: indexerVtxos[0].outpoint.txid });
  });

  it("never flips on an under-payment", async () => {
    const store = storeWith({ hash: "v1", amountMsat: 50_000 });
    const createdAt = store.get("v1")!.createdAt;
    indexerVtxos.push(wireVtxo({ txid: randomBytes(32).toString("hex"), valueSat: 49, createdAtSec: Math.floor(createdAt / 1000) }));

    expect(await settleDestinationPayments(store, new RestIndexerProvider(indexerCtx.baseUrl))).toBe(0);
    expect(store.get("v1")!.settled).toBe(false);
  });

  it("ignores payments older than the record (beyond clock-skew tolerance)", async () => {
    const now = Date.now();
    const store = storeWith({ hash: "v1", amountMsat: 50_000, createdAt: now });
    indexerVtxos.push(wireVtxo({ txid: randomBytes(32).toString("hex"), valueSat: 50, createdAtSec: Math.floor((now - SETTLEMENT_SKEW_MS - 60_000) / 1000) }));

    expect(await settleDestinationPayments(store, new RestIndexerProvider(indexerCtx.baseUrl))).toBe(0);
    expect(store.get("v1")!.settled).toBe(false);
  });

  it("tolerates a payment in the record's own second (wire granularity)", async () => {
    const store = storeWith({ hash: "v1", amountMsat: 50_000 });
    const createdAt = store.get("v1")!.createdAt;
    // same second, but earlier in ms than the record — must still match
    indexerVtxos.push(wireVtxo({ txid: randomBytes(32).toString("hex"), valueSat: 50, createdAtSec: Math.floor(createdAt / 1000) - 1 }));
    // -1s is within the skew window
    expect(await settleDestinationPayments(store, new RestIndexerProvider(indexerCtx.baseUrl))).toBe(1);
  });

  it("assigns one covering payment to only the oldest matching record", async () => {
    const store = storeWith({ hash: "v1", amountMsat: 50_000 }, { hash: "v2", amountMsat: 50_000 });
    const createdAt = store.get("v1")!.createdAt;
    indexerVtxos.push(wireVtxo({ txid: randomBytes(32).toString("hex"), valueSat: 50, createdAtSec: Math.floor(createdAt / 1000) }));

    expect(await settleDestinationPayments(store, new RestIndexerProvider(indexerCtx.baseUrl))).toBe(1);
    expect(store.get("v1")!.settled).toBe(true);
    expect(store.get("v2")!.settled).toBe(false);
  });

  it("leaves everything pending when the indexer errors", async () => {
    const store = storeWith({ hash: "v1", amountMsat: 50_000 });
    indexerFails = true;
    expect(await settleDestinationPayments(store, new RestIndexerProvider(indexerCtx.baseUrl))).toBe(0);
    expect(store.get("v1")!.settled).toBe(false);
  });
});

describe("arkade watcher end-to-end", () => {
  let db: Db;
  let repos: Repositories;

  beforeEach(() => {
    db = openDb(":memory:");
    runMigrations(db);
    repos = createRepositories(db);
    repos.domains.create({ domain: "domain.com", allocationModes: ["self"] });
  });
  afterAll(() => db?.close());

  it("callback → observed payment → verify reports settled with the txid reference", async () => {
    const settlements = new MemorySettlementStore(3_600_000);
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${port}`;
    server.on("request", createServer({ ...CONFIG, baseUrl }, { repos, settlements }));

    const a = repos.addresses.create({ domainId: repos.domains.list()[0].id, username: "alice", status: "active" });
    repos.addresses.setOfflineReceive(a.id, DEST, "02" + "ab".repeat(32));

    const cb = await new Promise<Record<string, unknown>>((resolve, reject) => {
      http.get(`${baseUrl}/.well-known/lnurlp/alice/callback?amount=50000&paymentOption=arkade`, { headers: { Host: "domain.com" } }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(JSON.parse(d)));
      }).on("error", reject);
    });
    expect(cb).toMatchObject({ status: "OK", paymentOption: "arkade", paymentDestination: DEST });
    const verifyId = String(cb.verify).split("/").pop()!;

    indexerVtxos.push(wireVtxo({ txid: randomBytes(32).toString("hex"), valueSat: 50, createdAtSec: Math.floor(Date.now() / 1000) }));
    expect(await settleDestinationPayments(settlements, new RestIndexerProvider(indexerCtx.baseUrl))).toBe(1);

    const v = await new Promise<Record<string, unknown>>((resolve, reject) => {
      http.get(`${baseUrl}/lnurl/verify/${verifyId}`, { headers: { Host: "domain.com" } }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(JSON.parse(d)));
      }).on("error", reject);
    });
    expect(v).toMatchObject({
      status: "OK",
      settled: true,
      paymentOption: "arkade",
      paymentDestination: DEST,
      paymentReference: indexerVtxos[0].outpoint.txid,
    });

    await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  });
});
