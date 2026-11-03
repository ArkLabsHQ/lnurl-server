import { describe, it, expect, vi } from "vitest";
import { lateCovenantSweep, startCovenantLateSweep, type LateSweepCursor } from "../src/workers/covenant-late-sweep.js";
import { MemorySettlementStore, type SettlementStore } from "../src/settlement-store.js";

const WATCH = 3_600_000;
const TAIL = WATCH * 10;

/** `count` lapsed, never-paid covenant destinations, scripts `5120{nn}` in order. */
function lapsedStore(count: number): { store: SettlementStore; scripts: string[]; advance: () => void } {
  let t = 1000;
  const store = new MemorySettlementStore(WATCH, () => t, WATCH);
  const scripts: string[] = [];
  for (let i = 0; i < count; i++) {
    const script = `5120${i.toString().padStart(4, "0")}`;
    scripts.push(script);
    store.create({ paymentHash: `h-${i}`, pr: "", sessionId: "s", paymentOption: "arkade", paymentDestination: "ark1x", amountMsat: 1000, covenantScript: script });
  }
  return { store, scripts, advance: () => { t += WATCH; } };
}

function fakes(funded: readonly string[] = []) {
  const getVtxos = vi.fn(async ({ scripts }: { scripts: string[] }) => ({
    vtxos: scripts.filter((s) => funded.includes(s)).map((s) => ({ txid: `tx-${s}`, vout: 0, value: 2000, script: s })),
  }));
  const sweep = vi.fn(async () => 0);
  return { indexer: { getVtxos } as never, sweeper: { sweep }, getVtxos, sweep };
}

const asked = (getVtxos: ReturnType<typeof vi.fn>): string[][] =>
  getVtxos.mock.calls.map(([q]) => (q as { scripts: string[] }).scripts);

describe("lateCovenantSweep", () => {
  it("examines no more than its budget, and resumes after the last one next pass", async () => {
    const { store, scripts, advance } = lapsedStore(10);
    advance();
    const { indexer, sweeper, getVtxos } = fakes();
    const cursor: LateSweepCursor = {};

    await lateCovenantSweep({ settlements: store, indexer, sweeper, tailMs: TAIL, cursor, budget: 4 });
    expect(asked(getVtxos).flat()).toEqual(scripts.slice(0, 4));

    getVtxos.mockClear();
    await lateCovenantSweep({ settlements: store, indexer, sweeper, tailMs: TAIL, cursor, budget: 4 });
    expect(asked(getVtxos).flat()).toEqual(scripts.slice(4, 8));
  });

  // node:sqlite is synchronous, so an unbounded tail read blocks the whole loop.
  it("reads at most a budget of rows however long the tail is", async () => {
    const { store, advance } = lapsedStore(500);
    advance();
    const { indexer, sweeper } = fakes();
    const read = vi.spyOn(store, "listLapsedCovenantScripts");

    await lateCovenantSweep({ settlements: store, indexer, sweeper, tailMs: TAIL, cursor: {}, budget: 16 });

    expect(read).toHaveBeenCalledExactlyOnceWith(TAIL, { limit: 16 });
    expect(read.mock.results[0]!.value).toHaveLength(16);
  });

  it("wraps to the start once it has been through the backlog", async () => {
    const { store, scripts, advance } = lapsedStore(5);
    advance();
    const { indexer, sweeper, getVtxos } = fakes();
    const cursor: LateSweepCursor = {};

    // 5 rows, budget 4: page one full, page two short, which resets the cursor.
    for (let pass = 0; pass < 2; pass++) {
      await lateCovenantSweep({ settlements: store, indexer, sweeper, tailMs: TAIL, cursor, budget: 4 });
    }
    expect(cursor.after).toBeUndefined();
    getVtxos.mockClear();
    await lateCovenantSweep({ settlements: store, indexer, sweeper, tailMs: TAIL, cursor, budget: 4 });

    expect(asked(getVtxos).flat()).toEqual(scripts.slice(0, 4));
  });

  it("asks the indexer 32 scripts at a time", async () => {
    const { store, advance } = lapsedStore(70);
    advance();
    const { indexer, sweeper, getVtxos } = fakes();

    await lateCovenantSweep({ settlements: store, indexer, sweeper, tailMs: TAIL, cursor: {}, budget: 70 });

    expect(asked(getVtxos).map((c) => c.length)).toEqual([32, 32, 6]);
  });

  it("hands the sweeper only the scripts that actually hold money", async () => {
    const { store, scripts, advance } = lapsedStore(4);
    advance();
    const { indexer, sweeper, sweep } = fakes([scripts[1]!, scripts[3]!]);

    await lateCovenantSweep({ settlements: store, indexer, sweeper, tailMs: TAIL, cursor: {} });

    expect(sweep).toHaveBeenCalledExactlyOnceWith([scripts[1], scripts[3]]);
  });

  it("does not call the sweeper at all when nothing is funded", async () => {
    const { store, advance } = lapsedStore(4);
    advance();
    const { indexer, sweeper, sweep } = fakes();

    await lateCovenantSweep({ settlements: store, indexer, sweeper, tailMs: TAIL, cursor: {} });

    expect(sweep).not.toHaveBeenCalled();
  });

  it("touches nothing still inside the attribution window, which the ordinary sweep owns", async () => {
    const { store, scripts } = lapsedStore(2);
    const { indexer, sweeper, getVtxos, sweep } = fakes(scripts);

    await lateCovenantSweep({ settlements: store, indexer, sweeper, tailMs: TAIL, cursor: {} });

    expect(getVtxos).not.toHaveBeenCalled();
    expect(sweep).not.toHaveBeenCalled();
  });

  it("touches nothing past the tail, however much money is there", async () => {
    const { store, scripts, advance } = lapsedStore(2);
    for (let i = 0; i < 12; i++) advance();
    const { indexer, sweeper, getVtxos, sweep } = fakes(scripts);

    await lateCovenantSweep({ settlements: store, indexer, sweeper, tailMs: TAIL, cursor: {} });

    expect(getVtxos).not.toHaveBeenCalled();
    expect(sweep).not.toHaveBeenCalled();
  });

  it("does nothing with the tail disabled", async () => {
    const { store, scripts, advance } = lapsedStore(2);
    advance();
    const { indexer, sweeper, getVtxos } = fakes(scripts);

    await lateCovenantSweep({ settlements: store, indexer, sweeper, tailMs: 0, cursor: {} });

    expect(getVtxos).not.toHaveBeenCalled();
  });

  it("never writes to the store, so a lapsed record stays lapsed and uncredited", async () => {
    const { store, scripts, advance } = lapsedStore(1);
    advance();
    const { indexer, sweeper } = fakes(scripts);

    await lateCovenantSweep({ settlements: store, indexer, sweeper, tailMs: TAIL, cursor: {} });

    expect(store.findByCovenantScript(scripts[0]!)).toMatchObject({ settled: false, payoutReference: null });
  });

  it("carries on past a failed chunk, so one bad read cannot strand the rest", async () => {
    const { store, scripts, advance } = lapsedStore(40);
    advance();
    const { sweeper, sweep } = fakes();
    let call = 0;
    const indexer = {
      getVtxos: async ({ scripts: chunk }: { scripts: string[] }) => {
        if (call++ === 0) throw new Error("indexer down");
        return { vtxos: chunk.map((s) => ({ txid: `tx-${s}`, vout: 0, value: 2000, script: s })) };
      },
    } as never;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await lateCovenantSweep({ settlements: store, indexer, sweeper, tailMs: TAIL, cursor: {}, budget: 40 });
      expect(sweep).toHaveBeenCalledExactlyOnceWith(scripts.slice(32, 40));
      expect(warn.mock.calls.flat().join(" ")).toContain("indexer down");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("startCovenantLateSweep", () => {
  it("runs a first pass and keeps the process alive for none of it", async () => {
    const { store, scripts, advance } = lapsedStore(1);
    advance();
    const { indexer, sweeper, sweep } = fakes(scripts);

    const loop = startCovenantLateSweep({ settlements: store, indexer, sweeper, tailMs: TAIL });
    try {
      await vi.waitFor(() => expect(sweep).toHaveBeenCalled());
    } finally {
      loop.stop();
    }
  });
});
