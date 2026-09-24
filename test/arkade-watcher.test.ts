import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { hex } from "@scure/base";
import { ArkAddress, RestIndexerProvider } from "@arkade-os/sdk";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { settleDestinationPayments, startArkadeWatcher, SETTLEMENT_SKEW_MS } from "../src/workers/arkade-watcher.js";
import { MemorySettlementStore } from "../src/settlement-store.js";
import { createServer } from "../src/http/server.js";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import type { LnurlServiceConfig } from "../src/types/index.js";

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

describe("startArkadeWatcher", () => {
  /** The provider PARSED shape: injection bypasses RestIndexerProvider. */
  const arrival = (script: string, value: number, createdAt: number) =>
    ({ txid: randomBytes(32).toString("hex"), vout: 0, value, createdAt: new Date(createdAt), script });

  /** Records what was watched; emits the watch-only shape: script, no contract. */
  function fakeContracts() {
    let handler: ((event: unknown) => void) | undefined;
    const watched: string[] = [];
    return {
      watched,
      emit: (contractScript: string) =>
        handler?.({ type: "vtxo_received", contractScript, vtxos: [], timestamp: Date.now() }),
      manager: {
        watchScript: async (script: string | string[]) => { watched.push(...(Array.isArray(script) ? script : [script])); },
        unwatchScript: async () => {},
        onContractEvent: (cb: (event: unknown) => void) => { handler = cb; return () => { handler = undefined; }; },
      },
    };
  }

  it("settles on watched-script activity rather than waiting out the catch-up", async () => {
    const store = storeWith({ hash: "w1", amountMsat: 50_000 });
    let visible: ReturnType<typeof arrival>[] = [];
    const fake = fakeContracts();
    const indexer = { getVtxos: async () => ({ vtxos: visible }) };
    // Long enough that a catch-up tick cannot be what settles this.
    const watcher = startArkadeWatcher(store, "http://unused", 600_000, {
      contracts: fake.manager as never, indexer: indexer as never, syncMs: 20,
    });
    try {
      await expect.poll(() => fake.watched.includes(DEST_SCRIPT), { timeout: 3000, interval: 20 }).toBe(true);
      expect(store.get("w1")!.settled).toBe(false);

      visible = [arrival(DEST_SCRIPT, 50, store.get("w1")!.createdAt)];
      fake.emit(DEST_SCRIPT);

      await expect.poll(() => store.get("w1")!.settled, { timeout: 5000, interval: 50 }).toBe(true);
    } finally {
      watcher.stop();
    }
  });

  it("ignores activity at a script it is not watching", async () => {
    const store = storeWith({ hash: "w2", amountMsat: 50_000 });
    const fake = fakeContracts();
    // Empty until after the boot pass, so only an event could settle this.
    let visible: ReturnType<typeof arrival>[] = [];
    const indexer = { getVtxos: async () => ({ vtxos: visible }) };
    const watcher = startArkadeWatcher(store, "http://unused", 600_000, {
      contracts: fake.manager as never, indexer: indexer as never, syncMs: 20,
    });
    try {
      await expect.poll(() => fake.watched.includes(DEST_SCRIPT), { timeout: 3000, interval: 20 }).toBe(true);

      // The money is there to be found; the event names someone else's script.
      visible = [arrival(DEST_SCRIPT, 50, store.get("w2")!.createdAt)];
      fake.emit("5120deadbeef");

      await new Promise((r) => setTimeout(r, 120));
      expect(store.get("w2")!.settled).toBe(false);
    } finally {
      watcher.stop();
    }
  });

  it("still settles from the catch-up when the manager cannot watch", async () => {
    const store = storeWith({ hash: "w3", amountMsat: 50_000 });
    const indexer = { getVtxos: async () => ({ vtxos: [arrival(DEST_SCRIPT, 50, store.get("w3")!.createdAt)] }) };
    // No contracts at all: the boot pass is the whole mechanism.
    const watcher = startArkadeWatcher(store, "http://unused", 600_000, { indexer: indexer as never });
    try {
      await expect.poll(() => store.get("w3")!.settled, { timeout: 5000, interval: 50 }).toBe(true);
    } finally {
      watcher.stop();
    }
  });
});

describe("startArkadeWatcher watch()", () => {
  const arrival = (script: string, value: number, createdAt: number) =>
    ({ txid: randomBytes(32).toString("hex"), vout: 0, value, createdAt: new Date(createdAt), script });

  it("registers a destination as it is issued, ahead of the resync", async () => {
    const store = storeWith({ hash: "h1", amountMsat: 50_000 });
    const watched: string[] = [];
    const manager = {
      watchScript: async (s: string | string[]) => { watched.push(...(Array.isArray(s) ? s : [s])); },
      unwatchScript: async () => {},
      onContractEvent: () => () => {},
    };
    // A resync far enough out that only watch() can explain the registration.
    const watcher = startArkadeWatcher(store, "http://unused", 600_000, {
      contracts: manager as never,
      indexer: { getVtxos: async () => ({ vtxos: [] as ReturnType<typeof arrival>[] }) } as never,
      syncMs: 600_000,
    });
    try {
      watcher.watch(DEST);
      await expect.poll(() => watched.includes(DEST_SCRIPT), { timeout: 2000, interval: 20 }).toBe(true);
    } finally {
      watcher.stop();
    }
  });

  it("ignores a destination that is not an Arkade address", async () => {
    // Empty: a pending record would be registered by the boot resync.
    const store = new MemorySettlementStore(3_600_000);
    const watched: string[] = [];
    const manager = {
      watchScript: async (s: string | string[]) => { watched.push(...(Array.isArray(s) ? s : [s])); },
      unwatchScript: async () => {},
      onContractEvent: () => () => {},
    };
    const watcher = startArkadeWatcher(store, "http://unused", 600_000, {
      contracts: manager as never,
      indexer: { getVtxos: async () => ({ vtxos: [] }) } as never,
      syncMs: 600_000,
    });
    try {
      // The onchain rail hands out a Bitcoin address; decoding it must not throw.
      watcher.watch("bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080");
      await new Promise((r) => setTimeout(r, 60));
      expect(watched).toHaveLength(0);
    } finally {
      watcher.stop();
    }
  });
});
