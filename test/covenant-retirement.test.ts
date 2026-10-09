import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import {
  ArkAddress,
  ContractManager,
  MultisigTapscript,
  RestIndexerProvider,
  VtxoScript,
  collectContracts,
  contractHandlers,
  type Contract,
  type IContractManager,
} from "@arkade-os/sdk";
import { openDb } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { sqliteContractStores } from "../src/contract-store.js";
import { DbSettlementStore, MemorySettlementStore } from "../src/settlement-store.js";
import { OfflineSwapStore } from "../src/offline-swap-store.js";
import { COVENANT_CONTRACT_TYPE, covenantDestinationHandler as handler } from "../src/covenant/contract.js";
import { COVENANT_V1 } from "../src/covenant/destination.js";
import { catchUp } from "../src/workers/covenant-watcher.js";
import { SWAP_LOCKUP_CONTRACT_TYPE } from "@arkade-os/swap/protocol";
import {
  activeCovenantFilters,
  retireFinishedCovenants,
  retireFinishedLockups,
  startContractRetirement,
} from "../src/workers/covenant-retirement.js";

// The watch set is the thing under test, not settlement: before retirement the
// subscription grew with every invoice ever handed out.

const xonly = (fill: number) => secp256k1.getPublicKey(new Uint8Array(32).fill(fill), true).subarray(1);

/** Real params, shared: a covenant build is ~12ms and the watch set is scripts. */
const realParams = handler.serializeParams({
  staticAddress: new VtxoScript([MultisigTapscript.encode({ pubkeys: [xonly(9), xonly(3)] }).script])
    .address("tark", xonly(3))
    .encode(),
  userPubkey: xonly(4),
  serverPubkey: xonly(3),
  emulatorPubkey: secp256k1.getPublicKey(new Uint8Array(32).fill(5), true),
  preimage: new Uint8Array(32).fill(7),
  recoveryDelaySeconds: 4096,
  version: COVENANT_V1,
});

const scriptOf = (i: number) => `5120${i.toString(16).padStart(64, "0")}`;

const row = (script: string, watch: Contract["watch"] = "awaiting-funds"): Contract => ({
  type: COVENANT_CONTRACT_TYPE,
  params: realParams,
  script,
  address: `tark1for-${script}`,
  state: "active",
  watch,
  createdAt: Date.now(),
});

/** What registerLockupContract writes: no `watch` at all. */
const lockupRow = (script: string): Contract => ({
  type: SWAP_LOCKUP_CONTRACT_TYPE,
  params: {},
  script,
  address: `tark1lockup-${script}`,
  state: "active",
  createdAt: Date.now(),
});

/** Tracks watch state as the SDK's repository does, so a retirement is observable
 *  without standing up a manager. */
function fakeManager(contracts: Contract[]) {
  const byScript = new Map(contracts.map((c) => [c.script, { ...c }]));
  const setContractWatchState = vi.fn(async (script: string, watch: Contract["watch"]) => {
    byScript.get(script)!.watch = watch;
  });
  const getContracts = vi.fn(async (filter?: { watch?: readonly string[]; type?: string }) =>
    [...byScript.values()].filter(
      (c) =>
        (!filter?.watch || filter.watch.includes(c.watch ?? "watched")) &&
        (filter?.type === undefined || c.type === filter.type),
    ),
  );
  return {
    manager: { getContracts, setContractWatchState } as unknown as IContractManager,
    getContracts,
    setContractWatchState,
    live: () => [...byScript.values()].filter((c) => c.watch !== "retained").map((c) => c.script),
  };
}

const storeWith = (
  recs: { hash: string; script: string }[],
  opts: { watchMs?: number; now?: () => number } = {},
) => {
  const s = new MemorySettlementStore(3_600_000, opts.now ?? (() => Date.now()), opts.watchMs ?? 604_800_000);
  for (const r of recs) {
    s.create({
      paymentHash: r.hash,
      pr: "",
      sessionId: "sess",
      paymentOption: "arkade",
      paymentDestination: `tark1for-${r.hash}`,
      amountMsat: 50_000,
      covenantScript: r.script,
    });
  }
  return s;
};

describe("retireFinishedCovenants", () => {
  it("retires a destination whose sweep has landed", async () => {
    const store = storeWith([{ hash: "v1", script: scriptOf(1) }]);
    store.markObserved("v1", "tx-in");
    store.markPaidOut("v1", "sweep-tx");
    const { manager, live } = fakeManager([row(scriptOf(1))]);

    expect(await retireFinishedCovenants(store, manager)).toBe(1);
    expect(live()).toEqual([]);
  });

  it("keeps watching a destination whose sweep has not landed", async () => {
    const store = storeWith([{ hash: "v1", script: scriptOf(1) }]);
    store.markObserved("v1", "tx-in");
    const { manager, live } = fakeManager([row(scriptOf(1))]);

    expect(await retireFinishedCovenants(store, manager)).toBe(0);
    expect(live()).toEqual([scriptOf(1)]);
  });

  // The dominant leak: an invoice nobody paid leaves a script watched for good.
  it("retires a never-paid destination as soon as it leaves the attribution window", async () => {
    let now = 1_000_000_000;
    const watchMs = 604_800_000;
    const store = storeWith([{ hash: "v1", script: scriptOf(1) }], { watchMs, now: () => now });
    const { manager, live } = fakeManager([row(scriptOf(1))]);

    expect(await retireFinishedCovenants(store, manager)).toBe(0);
    expect(live()).toEqual([scriptOf(1)]);

    now += watchMs;
    expect(await retireFinishedCovenants(store, manager)).toBe(1);
    expect(live()).toEqual([]);
  });

  it("never retires a settled destination whose sweep has not landed, however late", async () => {
    let now = 1_000_000_000;
    const watchMs = 604_800_000;
    const store = storeWith([{ hash: "v1", script: scriptOf(1) }], { watchMs, now: () => now });
    store.markObserved("v1", "tx-in");
    const { manager, live } = fakeManager([row(scriptOf(1))]);

    now += watchMs * 14;
    expect(await retireFinishedCovenants(store, manager)).toBe(0);
    expect(live()).toEqual([scriptOf(1)]);

    store.markPaidOut("v1", "sweep-tx");
    expect(await retireFinishedCovenants(store, manager)).toBe(1);
    expect(live()).toEqual([]);
  });

  it("names the backlog once when it cannot clear it in one pass", async () => {
    const store = storeWith([]);
    const { manager } = fakeManager(Array.from({ length: 450 }, (_, i) => row(scriptOf(i))));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await retireFinishedCovenants(store, manager);
      expect(log).toHaveBeenCalledWith("covenant retirement: 450 to retire, 100 per pass");
    } finally {
      log.mockRestore();
    }
  });

  it("says nothing about a backlog it clears in one pass", async () => {
    const store = storeWith([]);
    const { manager } = fakeManager([row(scriptOf(1))]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await retireFinishedCovenants(store, manager);
      expect(log.mock.calls.flat().join(" ")).not.toContain("per pass");
    } finally {
      log.mockRestore();
    }
  });

  it("reads only the live watch states, never the whole history", async () => {
    const store = storeWith([]);
    const { manager, getContracts } = fakeManager([row(scriptOf(1), "retained")]);

    await retireFinishedCovenants(store, manager);

    expect(getContracts).toHaveBeenCalledWith({
      type: COVENANT_CONTRACT_TYPE,
      watch: ["watched", "awaiting-funds"],
    });
  });

  // Retiring one re-posts the whole subscription: a one-pass drain is quadratic.
  it("caps a pass so draining a backlog cannot re-post the subscription N times", async () => {
    const store = storeWith([]);
    const { manager, setContractWatchState } = fakeManager(
      Array.from({ length: 450 }, (_, i) => row(scriptOf(i))),
    );

    const first = await retireFinishedCovenants(store, manager);
    expect(first).toBeLessThan(450);
    expect(setContractWatchState).toHaveBeenCalledTimes(first);

    let total = first;
    for (let pass = 0; pass < 20 && total < 450; pass++) total += await retireFinishedCovenants(store, manager);
    expect(total).toBe(450);
  });

  it("survives a manager that refuses one retirement and retires the rest", async () => {
    const store = storeWith([]);
    const { manager, setContractWatchState } = fakeManager([row(scriptOf(1)), row(scriptOf(2))]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setContractWatchState.mockRejectedValueOnce(new Error("disk full"));

    expect(await retireFinishedCovenants(store, manager)).toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("activeCovenantFilters", () => {
  it("is empty when nothing is in play, so a quiet server queries nothing", () => {
    expect(activeCovenantFilters(storeWith([]))).toEqual([]);
  });

  it("scopes a pass to the destinations still in play", () => {
    const store = storeWith([{ hash: "v1", script: scriptOf(1) }, { hash: "v2", script: scriptOf(2) }]);
    store.markObserved("v2", "tx-in");
    store.markPaidOut("v2", "sweep-tx");

    expect(activeCovenantFilters(store)).toEqual([{ script: [scriptOf(1)] }]);
  });

  // `script IN (...)` has a parameter ceiling; a burst must not break the sweep.
  it("chunks a large set so one SQL parameter list cannot overflow", () => {
    const store = storeWith(Array.from({ length: 1000 }, (_, i) => ({ hash: `v${i}`, script: scriptOf(i) })));

    const filters = activeCovenantFilters(store);

    expect(filters.length).toBeGreaterThan(1);
    expect(Math.max(...filters.map((f) => (f.script as string[]).length))).toBeLessThanOrEqual(500);
    expect(filters.flatMap((f) => f.script as string[])).toHaveLength(1000);
  });
});

describe("startContractRetirement", () => {
  it("retires on its own clock and stops when stopped", async () => {
    vi.useFakeTimers();
    try {
      const store = storeWith([]);
      const { manager, setContractWatchState } = fakeManager([row(scriptOf(1))]);

      const handle = startContractRetirement(store, manager, 60_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(setContractWatchState).toHaveBeenCalledTimes(1);

      handle.stop();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(setContractWatchState).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── The measurement: what lnurl-server actually asks arkd's indexer to watch ──

/** Records every POST /v1/indexer/script/subscribe; the last is the real watch set. */
function recordingIndexer(): Promise<{
  baseUrl: string;
  subscribes: string[][];
  close: () => Promise<void>;
}> {
  const subscribes: string[][] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.includes("/script/subscribe")) {
        subscribes.push((JSON.parse(body || "{}") as { scripts?: string[] }).scripts ?? []);
        res.end(JSON.stringify({ subscriptionId: "sub-1" }));
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
        subscribes,
        close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
      });
    });
  });
}

describe("the watch set at scale", () => {
  const LIVE = 5;
  let indexer: Awaited<ReturnType<typeof recordingIndexer>>;
  let dir: string;

  beforeAll(async () => {
    indexer = await recordingIndexer();
    contractHandlers.register(handler);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lnurl-scale-"));
  });
  afterAll(async () => {
    await indexer.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const lockupAddress = (i: number) =>
    new ArkAddress(xonly(2), hex.decode((1_000_000 + i).toString(16).padStart(64, "0")), "tark").encode();
  const lockupScriptOf = (i: number) => hex.encode(ArkAddress.decode(lockupAddress(i)).pkScript);

  /** File-backed, so "restart" is a second manager over the same rows. */
  const seeded = async (name: string, dead: number) => {
    const file = path.join(dir, `${name}.db`);
    const db = openDb(file);
    runMigrations(db);
    const settlements = new DbSettlementStore(db, 3_600_000, undefined, 604_800_000);
    const { contractRepository } = await sqliteContractStores(db);
    await collectContracts(contractRepository);
    const insertSwap = db.prepare(
      "INSERT INTO settlements (payment_hash, pr, session_id, settled, preimage, swap_id, payment_option, amount_msat, created_at, updated_at)" +
        " VALUES (?, 'lnbc1', 'offline:1', ?, ?, ?, 'lightning', 50000, ?, ?)",
    );
    const insertLockup = db.prepare(
      "INSERT INTO offline_swaps (payment_hash, rfq_id, solver_name, solver_pubkey, relays_json, recovery_version, recovery_json, lockup_address, expected_amount, created_at)" +
        " VALUES (?, ?, 'one', '11', '[\"wss://relay.example\"]', 1, '{}', ?, 1, ?)",
    );

    const at = Date.now();
    db.exec("BEGIN");
    for (let i = 0; i < dead + LIVE; i++) {
      const script = scriptOf(i);
      await contractRepository.saveContract(row(script));
      settlements.create({
        paymentHash: `pay-${i}`,
        pr: "",
        sessionId: "sess",
        paymentOption: "arkade",
        paymentDestination: `tark1for-${i}`,
        amountMsat: 50_000,
        covenantScript: script,
      });
      // Every destination but the last LIVE is finished: paid and swept.
      if (i < dead) {
        settlements.markObserved(`pay-${i}`, `tx-${i}`);
        settlements.markPaidOut(`pay-${i}`, `sweep-${i}`);
      }
      // Rows inserted directly: createAccepted opens its own transaction.
      await contractRepository.saveContract(lockupRow(lockupScriptOf(i)));
      // Fresh: a lockup outside the poller's window is inactive whatever its swap says.
      insertSwap.run(`swap-${i}`, i < dead ? 1 : 0, `bb${i}`, `rfq-${i}`, at, at);
      insertLockup.run(`swap-${i}`, `rfq-${i}`, lockupAddress(i), at);
    }
    db.exec("COMMIT");
    db.close();
    return file;
  };

  const boot = async (file: string) => {
    const db = openDb(file);
    const settlements = new DbSettlementStore(db, 3_600_000, undefined, 604_800_000);
    const contracts = await ContractManager.create({
      indexerProvider: new RestIndexerProvider(indexer.baseUrl),
      ...(await sqliteContractStores(db)),
    });
    const swaps = new OfflineSwapStore(db, 3_600_000);
    return { db, settlements, swaps, contracts, close: () => { contracts.dispose(); db.close(); } };
  };

  it("subscribes the live destinations and lockups only, across a restart", async () => {
    // Modest on purpose — a drain costs one subscribe POST per retirement. Still
    // three passes at the cap; scripts/probe-watchset.ts runs this at 10k.
    const DEAD = 150;
    const file = await seeded("restart", DEAD);

    // Both backlogs on the wire, as before retirement: one lockup per destination.
    indexer.subscribes.length = 0;
    const first = await boot(file);
    expect(indexer.subscribes.at(-1)).toHaveLength((DEAD + LIVE) * 2);

    let guard = 0;
    while (
      (await retireFinishedCovenants(first.settlements, first.contracts)) +
        (await retireFinishedLockups(first.swaps, first.contracts)) >
      0
    ) {
      expect(++guard).toBeLessThan(400);
    }
    first.close();

    // The restart is the real proof: nothing resubscribes what was retired.
    indexer.subscribes.length = 0;
    const second = await boot(file);
    try {
      expect(indexer.subscribes.at(-1)).toHaveLength(LIVE * 2);
      expect(await second.contracts.getContracts({ type: COVENANT_CONTRACT_TYPE })).toHaveLength(DEAD + LIVE);
      expect(
        await second.contracts.getContracts({ type: COVENANT_CONTRACT_TYPE, watch: ["watched", "awaiting-funds"] }),
      ).toHaveLength(LIVE);
      expect(await second.contracts.getContracts({ type: SWAP_LOCKUP_CONTRACT_TYPE })).toHaveLength(DEAD + LIVE);
      expect(
        await second.contracts.getContracts({ type: SWAP_LOCKUP_CONTRACT_TYPE, watch: ["watched", "awaiting-funds"] }),
      ).toHaveLength(LIVE);
      // Retired, never deleted: the row holds the preimage the sweep leaf needs.
      expect(await second.contracts.getContracts({ type: COVENANT_CONTRACT_TYPE, watch: ["retained"] })).toHaveLength(DEAD);

      // The property the sweeper's safety rests on, against a real manager: a
      // retired destination is still reachable — and still synced — by an explicit
      // script filter. Were it not, a late or failed sweep would strand the money.
      const retired = scriptOf(0);
      const reached = await second.contracts.getContractsWithVtxos({
        type: COVENANT_CONTRACT_TYPE,
        script: [retired],
      });
      expect(reached.map((r) => r.contract.script)).toEqual([retired]);
    } finally {
      second.close();
    }
  }, 120_000);

  it("bounds a worker pass by the destinations in play, not by history", async () => {
    const DEAD = 1_200;
    const file = await seeded("per-pass", DEAD);
    const { settlements, contracts, close } = await boot(file);
    try {
      expect(await contracts.getContracts({ type: COVENANT_CONTRACT_TYPE })).toHaveLength(DEAD + LIVE);

      const filters = activeCovenantFilters(settlements);
      expect(filters.flatMap((f) => f.script as string[])).toHaveLength(LIVE);

      const visited = (await Promise.all(filters.map((f) => contracts.getContractsWithVtxos(f)))).flat();
      expect(visited).toHaveLength(LIVE);
    } finally {
      close();
    }
  }, 120_000);

  it("resolves a pass's scope by primary key, not by contract type", async () => {
    const { db, settlements, contracts, close } = await boot(await seeded("scope-plan", 20));
    const prepare = db.prepare.bind(db);
    const seen: string[] = [];
    db.prepare = (sql: string) => (seen.push(sql), prepare(sql));
    try {
      await catchUp(settlements, contracts);
      db.prepare = prepare;
      const scopes = seen.filter((sql) => sql.includes("FROM ark_contracts WHERE script IN (?, ?, ?"));
      expect(scopes).not.toHaveLength(0);
      for (const sql of scopes) {
        const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail).join(" | ");
        expect(plan).toContain("sqlite_autoindex_ark_contracts_1");
      }
    } finally {
      db.prepare = prepare;
      close();
    }
  }, 120_000);
});

describe("retireFinishedLockups", () => {
  const swapsWith = (active: string[]) => ({ listActiveLockupScripts: () => active }) as never;

  it("retires a lockup whose swap is settled or past the poller's window", async () => {
    const { manager, live } = fakeManager([lockupRow(scriptOf(1)), lockupRow(scriptOf(2))]);

    expect(await retireFinishedLockups(swapsWith([]), manager)).toBe(2);
    expect(live()).toEqual([]);
  });

  it("keeps a lockup its swap is still pending on", async () => {
    const { manager, live } = fakeManager([lockupRow(scriptOf(1)), lockupRow(scriptOf(2))]);

    expect(await retireFinishedLockups(swapsWith([scriptOf(1)]), manager)).toBe(1);
    expect(live()).toEqual([scriptOf(1)]);
  });

  it("asks only about lockup contracts, by the type the swap package registers", async () => {
    const { manager, getContracts } = fakeManager([]);

    await retireFinishedLockups(swapsWith([]), manager);

    expect(getContracts).toHaveBeenCalledWith({
      type: SWAP_LOCKUP_CONTRACT_TYPE,
      watch: ["watched", "awaiting-funds"],
    });
  });

  it("never touches a covenant destination", async () => {
    const { manager, live } = fakeManager([row(scriptOf(7)), lockupRow(scriptOf(8))]);

    await retireFinishedLockups(swapsWith([]), manager);

    expect(live()).toEqual([scriptOf(7)]);
  });
});

describe("startContractRetirement with both rails", () => {
  it("spends one per-pass budget across destinations and lockups", async () => {
    vi.useFakeTimers();
    try {
      const store = storeWith([]);
      const contracts = [
        ...Array.from({ length: 80 }, (_, i) => row(scriptOf(i))),
        ...Array.from({ length: 80 }, (_, i) => lockupRow(scriptOf(1000 + i))),
      ];
      const { manager, setContractWatchState } = fakeManager(contracts);

      const handle = startContractRetirement(store, manager, 600_000, { listActiveLockupScripts: () => [] } as never);
      await vi.advanceTimersByTimeAsync(0);

      expect(setContractWatchState).toHaveBeenCalledTimes(100);
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
