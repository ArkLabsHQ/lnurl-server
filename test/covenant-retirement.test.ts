import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  ContractManager,
  MultisigTapscript,
  RestIndexerProvider,
  VtxoScript,
  contractHandlers,
  type Contract,
  type IContractManager,
} from "@arkade-os/sdk";
import { openDb } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { sqliteContractStores } from "../src/contract-store.js";
import { DbSettlementStore, MemorySettlementStore } from "../src/settlement-store.js";
import { COVENANT_CONTRACT_TYPE, covenantDestinationHandler as handler } from "../src/covenant/contract.js";
import { COVENANT_V1 } from "../src/covenant/destination.js";
import {
  activeCovenantFilters,
  retireFinishedCovenants,
  startCovenantRetirement,
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

/** Tracks watch state as the SDK's repository does, so a retirement is observable
 *  without standing up a manager. */
function fakeManager(contracts: Contract[]) {
  const byScript = new Map(contracts.map((c) => [c.script, { ...c }]));
  const setContractWatchState = vi.fn(async (script: string, watch: Contract["watch"]) => {
    byScript.get(script)!.watch = watch;
  });
  const getContracts = vi.fn(async (filter?: { watch?: readonly string[] }) =>
    [...byScript.values()].filter((c) => !filter?.watch || filter.watch.includes(c.watch ?? "watched")),
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

    expect(activeCovenantFilters(store)).toEqual([
      { type: COVENANT_CONTRACT_TYPE, script: [scriptOf(1)] },
    ]);
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

describe("startCovenantRetirement", () => {
  it("retires on its own clock and stops when stopped", async () => {
    vi.useFakeTimers();
    try {
      const store = storeWith([]);
      const { manager, setContractWatchState } = fakeManager([row(scriptOf(1))]);

      const handle = startCovenantRetirement(store, manager, 60_000);
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

  /** File-backed, so "restart" is a second manager over the same rows. */
  const seeded = async (name: string, dead: number) => {
    const file = path.join(dir, `${name}.db`);
    const db = openDb(file);
    runMigrations(db);
    const settlements = new DbSettlementStore(db, 3_600_000, undefined, 604_800_000);
    const { contractRepository } = await sqliteContractStores(db);
    await contractRepository.getContracts();

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
    return { db, settlements, contracts, close: () => { contracts.dispose(); db.close(); } };
  };

  it("subscribes the live destinations only, and stays that way across a restart", async () => {
    // Modest on purpose — a drain costs one subscribe POST per retirement. Still
    // three passes at the cap; scripts/probe-watchset.ts runs this at 10k.
    const DEAD = 150;
    const file = await seeded("restart", DEAD);

    // First boot: the backlog is on the wire, exactly as it was before retirement.
    indexer.subscribes.length = 0;
    const first = await boot(file);
    expect(indexer.subscribes.at(-1)).toHaveLength(DEAD + LIVE);

    let guard = 0;
    while ((await retireFinishedCovenants(first.settlements, first.contracts)) > 0) {
      expect(++guard).toBeLessThan(200);
    }
    first.close();

    // The restart is the real proof: nothing resubscribes what was retired.
    indexer.subscribes.length = 0;
    const second = await boot(file);
    try {
      expect(indexer.subscribes.at(-1)).toHaveLength(LIVE);
      expect(await second.contracts.getContracts({ type: COVENANT_CONTRACT_TYPE })).toHaveLength(DEAD + LIVE);
      expect(
        await second.contracts.getContracts({ type: COVENANT_CONTRACT_TYPE, watch: ["watched", "awaiting-funds"] }),
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
});
