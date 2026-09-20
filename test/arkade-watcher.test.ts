import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
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
/** Round trips the pass made — the cost this watcher is measured by. */
let indexerRequests: number;
let indexerCtx: { baseUrl: string; close: () => Promise<void> };

beforeAll(async () => {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    const url = new URL(req.url ?? "", "http://x");
    if (url.pathname === "/v1/indexer/vtxos" && !indexerFails) {
      indexerRequests++;
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
  indexerRequests = 0;
});

function storeWith(...recs: { hash: string; amountMsat: number; createdAt?: number }[]): MemorySettlementStore {
  const s = new MemorySettlementStore(3_600_000);
  for (const r of recs) {
    s.create({ paymentHash: r.hash, pr: "", sessionId: "sess", paymentOption: "arkade", paymentDestination: DEST, amountMsat: r.amountMsat });
    // createdAt is stamped from the store clock at create; backdate via a wrapped store when needed
    if (r.createdAt !== undefined) {
      const rec = s.get(r.hash)!;
      rec.createdAt = r.createdAt;
    }
  }
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

  it("never settles a later record from an already-used payment (cross-pass replay)", async () => {
    const store = storeWith({ hash: "r1", amountMsat: 50_000 });
    const createdAt = store.get("r1")!.createdAt;
    const txid = randomBytes(32).toString("hex");
    indexerVtxos.push(wireVtxo({ txid, valueSat: 50, createdAtSec: Math.floor(createdAt / 1000) }));

    expect(await settleDestinationPayments(store, new RestIndexerProvider(indexerCtx.baseUrl))).toBe(1);
    expect(store.get("r1")).toMatchObject({ settled: true, paymentReference: txid });

    // A second request to the same address; the same payment must not settle it.
    store.create({ paymentHash: "r2", pr: "", sessionId: "sess", paymentOption: "arkade", paymentDestination: DEST, amountMsat: 50_000 });
    expect(await settleDestinationPayments(store, new RestIndexerProvider(indexerCtx.baseUrl))).toBe(0);
    expect(store.get("r2")!.settled).toBe(false);
  });

  // The cost that decides whether this scales: a pass used to spend one round
  // trip per open payment, so a 15s interval saturated somewhere near a hundred
  // of them. Asserted on request count, because that is the thing that broke.
  it("reads many destinations in batches, not one request per destination", async () => {
    const store = new MemorySettlementStore(3_600_000);
    const dests: string[] = [];
    for (let i = 0; i < 40; i++) {
      const dest = new ArkAddress(
        secp256k1.utils.randomSecretKey(),
        secp256k1.utils.randomSecretKey(),
        "tark",
      ).encode();
      dests.push(dest);
      store.create({
        paymentHash: `b${i}`,
        pr: "",
        sessionId: "sess",
        paymentOption: "arkade",
        paymentDestination: dest,
        amountMsat: 50_000,
      });
    }
    // One payment, at a destination in the SECOND chunk, so the assertion also
    // proves the batches are regrouped by script rather than merged.
    const target = dests[35]!;
    const txid = randomBytes(32).toString("hex");
    indexerVtxos = [
      wireVtxo({
        txid,
        valueSat: 60,
        createdAtSec: Math.floor(Date.now() / 1000),
        script: hex.encode(ArkAddress.decode(target).pkScript),
      }),
    ];

    expect(await settleDestinationPayments(store, new RestIndexerProvider(indexerCtx.baseUrl))).toBe(1);
    expect(indexerRequests).toBe(2); // ceil(40 / 32)
    expect(store.get("b35")).toMatchObject({ settled: true, paymentReference: txid });
    expect(store.get("b34")!.settled).toBe(false);
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
  afterEach(() => db.close());

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
    // A static destination is not handed a verify URL -- it cannot tell two
    // same-amount payments apart -- but the record still exists and the watcher
    // still settles it, which is what this test is about. The endpoint itself is
    // unchanged, so take the id from the store rather than from the response.
    expect(cb.verify).toBeUndefined();
    const verifyId = settlements.listRecent(10, { option: "arkade" })[0]!.paymentHash;

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
    // Owner-only: verify is public and this txid would link a covenant destination.
    expect(v).not.toHaveProperty("payoutReference");

    await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  });
});

describe("settleDestinationPayments failure reporting", () => {
  // A misconfigured indexer looks exactly like an unreachable one and never
  // resolves itself: without this the rail stops settling and says nothing.
  it("reports an indexer it cannot reach instead of swallowing it", async () => {
    const store = storeWith({ hash: "v1", amountMsat: 50_000 });
    const failures: string[] = [];

    const n = await settleDestinationPayments(
      store,
      new RestIndexerProvider("http://127.0.0.1:1"),
      (stage, err) => failures.push(`${stage}: ${err instanceof Error ? err.message : String(err)}`),
    );

    expect(n).toBe(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("static-address lookup");
    expect(store.get("v1")!.settled).toBe(false);
  });

  it("still swallows failures when no reporter is supplied", async () => {
    const store = storeWith({ hash: "v1", amountMsat: 50_000 });
    await expect(settleDestinationPayments(store, new RestIndexerProvider("http://127.0.0.1:1"))).resolves.toBe(0);
  });
});

describe("rails this watcher does not own", () => {
  // Boarding addresses are bech32m Bitcoin, not Arkade, so decoding one always
  // throws. They were reported as failures on every tick for the whole seven-day
  // destination window — and a reported failure also suppresses the clean-pass
  // reset, so permanent noise here can mask a real indexer outage.
  it("ignores an onchain record instead of failing to decode it every pass", async () => {
    const store = new MemorySettlementStore(3_600_000);
    store.create({
      paymentHash: "onchain-1", pr: "", sessionId: "sess", paymentOption: "onchain",
      paymentDestination: "bcrt1p8562tv467hp2zjckrpfk4qyafqf0elnz9n6tjneph6e9klksgfvsp7a4ld",
      amountMsat: 1_000_000,
    });
    const failures: string[] = [];
    const settled = await settleDestinationPayments(
      store,
      new RestIndexerProvider(indexerCtx.baseUrl),
      (stage) => failures.push(stage),
    );
    expect(settled).toBe(0);
    expect(failures).toEqual([]);
  });

  it("still reports a genuinely malformed arkade destination", async () => {
    const store = new MemorySettlementStore(3_600_000);
    store.create({
      paymentHash: "bad-arkade", pr: "", sessionId: "sess", paymentOption: "arkade",
      paymentDestination: "tark1nonsense", amountMsat: 1_000_000,
    });
    const failures: string[] = [];
    await settleDestinationPayments(store, new RestIndexerProvider(indexerCtx.baseUrl), (stage) => failures.push(stage));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("undecodable destination");
  });
});
