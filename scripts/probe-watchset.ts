/**
 * Counts the scripts this server asks arkd's indexer to watch, before and after
 * retirement, once N covenant destinations have reached a terminal state and the
 * process has restarted. Funds nothing and touches no real arkd — the indexer is a
 * local stub. `scriptsOnTheWire` should track `liveDestinations`, not
 * `contractsStored`; that gap was the leak.
 *   pnpm tsx scripts/probe-watchset.ts [n] [live]
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  ContractManager,
  MultisigTapscript,
  RestIndexerProvider,
  VtxoScript,
  collectContracts,
  contractHandlers,
} from "@arkade-os/sdk";
import { openDb } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { sqliteContractStores } from "../src/contract-store.js";
import { DbSettlementStore } from "../src/settlement-store.js";
import { COVENANT_CONTRACT_TYPE, covenantDestinationHandler } from "../src/covenant/contract.js";
import { COVENANT_CURRENT } from "../src/covenant/destination.js";
import { retireFinishedCovenants } from "../src/workers/covenant-retirement.js";

const N = Number(process.argv[2] ?? 10_000);
const LIVE = Number(process.argv[3] ?? 5);
const WATCH_MS = 604_800_000;

/** Newest body only: retaining all of them is itself an OOM at this N, since a
 *  drain re-posts the whole script list once per retirement. */
function stubIndexer(): Promise<{
  baseUrl: string;
  seen: { last: number; calls: number };
  close: () => Promise<void>;
}> {
  const seen = { last: 0, calls: 0 };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.includes("/script/subscribe")) {
        seen.last = ((JSON.parse(body || "{}") as { scripts?: string[] }).scripts ?? []).length;
        seen.calls++;
        res.end(JSON.stringify({ subscriptionId: "probe" }));
        return;
      }
      res.end(JSON.stringify({ vtxos: [], page: null, txs: [], chains: [] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        seen,
        close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
      });
    });
  });
}

const xonly = (fill: number) => secp256k1.getPublicKey(new Uint8Array(32).fill(fill), true).subarray(1);
/** Shared: one real covenant build is ~12ms. */
const params = covenantDestinationHandler.serializeParams({
  staticAddress: new VtxoScript([MultisigTapscript.encode({ pubkeys: [xonly(9), xonly(3)] }).script])
    .address("tark", xonly(3))
    .encode(),
  userPubkey: xonly(4),
  serverPubkey: xonly(3),
  emulatorPubkey: secp256k1.getPublicKey(new Uint8Array(32).fill(5), true),
  preimage: new Uint8Array(32).fill(7),
  recoveryDelaySeconds: 4096,
  version: COVENANT_CURRENT,
});
const scriptOf = (i: number) => `5120${i.toString(16).padStart(64, "0")}`;

const indexer = await stubIndexer();
contractHandlers.register(covenantDestinationHandler);
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lnurl-watchset-")), "probe.db");

const open = async () => {
  const db = openDb(file);
  runMigrations(db);
  const settlements = new DbSettlementStore(db, 3_600_000, undefined, WATCH_MS);
  const stores = await sqliteContractStores(db);
  return { db, settlements, stores };
};

// Seed in one transaction: per-row commits dominate everything else at this N.
let t0 = Date.now();
{
  const { db, settlements, stores } = await open();
  await collectContracts(stores.contractRepository);
  db.exec("BEGIN");
  for (let i = 0; i < N; i++) {
    const script = scriptOf(i);
    await stores.contractRepository.saveContract({
      type: COVENANT_CONTRACT_TYPE,
      params,
      script,
      address: `tark1probe-${i}`,
      state: "active",
      watch: "awaiting-funds",
      createdAt: Date.now(),
    });
    settlements.create({
      paymentHash: `pay-${i}`,
      pr: "",
      sessionId: "probe",
      paymentOption: "arkade",
      paymentDestination: `tark1probe-${i}`,
      amountMsat: 50_000,
      covenantScript: script,
    });
    if (i >= LIVE) {
      settlements.markObserved(`pay-${i}`, `tx-${i}`);
      settlements.markPaidOut(`pay-${i}`, `sweep-${i}`);
    }
  }
  db.exec("COMMIT");
  db.close();
}
const seedMs = Date.now() - t0;

const boot = async () => {
  const { db, settlements, stores } = await open();
  const contracts = await ContractManager.create({
    indexerProvider: new RestIndexerProvider(indexer.baseUrl),
    ...stores,
  });
  return { db, settlements, contracts, close: () => { contracts.dispose(); db.close(); } };
};

t0 = Date.now();
const before = await boot();
const bootBeforeMs = Date.now() - t0;
const wireBefore = indexer.seen.last;

t0 = Date.now();
let passes = 0;
while ((await retireFinishedCovenants(before.settlements, before.contracts)) > 0) passes++;
const drainMs = Date.now() - t0;
before.close();

indexer.seen.calls = 0;
t0 = Date.now();
const after = await boot();
const bootAfterMs = Date.now() - t0;
const stored = await after.contracts.getContracts({ type: COVENANT_CONTRACT_TYPE });
const live = await after.contracts.getContracts({
  type: COVENANT_CONTRACT_TYPE,
  watch: ["watched", "awaiting-funds"],
});

console.log(
  JSON.stringify(
    {
      n: N,
      liveDestinations: LIVE,
      seedMs,
      contractsStored: stored.length,
      scriptsOnTheWireBefore: wireBefore,
      bootBeforeMs,
      retirementPasses: passes,
      drainMs,
      scriptsOnTheWireAfter: indexer.seen.last,
      subscribeCallsOnRestart: indexer.seen.calls,
      liveByWatchState: live.length,
      bootAfterMs,
      retainedRows: stored.length - live.length,
      exampleRetiredScript: hex.encode(hex.decode(scriptOf(N - 1))).slice(0, 16),
    },
    null,
    2,
  ),
);

after.close();
await indexer.close();
fs.rmSync(path.dirname(file), { recursive: true, force: true });
