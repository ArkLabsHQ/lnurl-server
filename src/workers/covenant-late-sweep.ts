// The tail behind the attribution window: a payer who pays a per-payment covenant
// destination after it lapses leaves funds at a script no other pass's scope names.
// Money only — the record stays unsettled and lapsed, because re-attributing it would
// contradict what every caller was already told.
//
// A full cycle is ceil(n / LATE_SWEEP_PER_PASS) intervals, which must stay well inside a
// coin's batch expiry: a late deposit arrives with that clock already running, and only
// v3 has a renewal path once it passes.

import type { IndexerProvider } from "@arkade-os/sdk";
import type { SettlementStore } from "../settlement-store.js";
import type { CovenantSweeper } from "./covenant-sweeper.js";
import { startCatchUpLoop, type CatchUpLoop } from "./catch-up-loop.js";

/** Scripts per indexer read, matching src/services/reconcile.ts. */
const DISCOVERY_CHUNK = 32;

/** The budget that makes a pass's cost flat, and its interval. */
export const LATE_SWEEP_PER_PASS = 256;
export const LATE_SWEEP_INTERVAL_MS = 600_000;

/** Keyset, not an offset: the tail gains rows at one end and loses them at the other
 *  between passes, which would silently skip whatever an index had shifted past. */
export interface LateSweepCursor {
  after?: string;
}

export interface LateSweepOptions {
  settlements: SettlementStore;
  indexer: Pick<IndexerProvider, "getVtxos">;
  sweeper: Pick<CovenantSweeper, "sweep">;
  tailMs: number;
  cursor?: LateSweepCursor;
  budget?: number;
}

/** One pass. Returns how many destinations the sweeper moved. */
export async function lateCovenantSweep(opts: LateSweepOptions): Promise<number> {
  const cursor = opts.cursor ?? {};
  const budget = opts.budget ?? LATE_SWEEP_PER_PASS;
  // Sorted so the cursor means the same thing from one pass to the next.
  const lapsed = [...opts.settlements.listLapsedCovenantScripts(opts.tailMs)].sort();
  if (lapsed.length === 0) {
    delete cursor.after;
    return 0;
  }
  const after = cursor.after;
  const pending = after === undefined ? lapsed : lapsed.filter((s) => s > after);
  // Through the backlog: start over rather than idle on a deposit that may yet arrive.
  const slice = (pending.length > 0 ? pending : lapsed).slice(0, budget);
  cursor.after = slice[slice.length - 1];

  const funded: string[] = [];
  for (let i = 0; i < slice.length; i += DISCOVERY_CHUNK) {
    const chunk = slice.slice(i, i + DISCOVERY_CHUNK);
    try {
      // Spendable or recoverable: a deposit past its batch expiry is still money, and an
      // already-swept output is spent, so it drops out with no bookkeeping of ours.
      const { vtxos } = await opts.indexer.getVtxos({ scripts: chunk, renewableOnly: true });
      const seen = new Set(vtxos.map((v) => v.script));
      for (const script of chunk) if (seen.has(script)) funded.push(script);
    } catch (err) {
      console.warn(`covenant late sweep: lookup for ${chunk.length} lapsed destination(s) failed:`, err);
    }
  }
  if (funded.length === 0) return 0;
  console.log(`covenant late sweep: ${funded.length} lapsed destination(s) still funded`);
  return await opts.sweeper.sweep(funded);
}

export function startCovenantLateSweep(opts: LateSweepOptions & { intervalMs?: number }): CatchUpLoop {
  const cursor: LateSweepCursor = opts.cursor ?? {};
  return startCatchUpLoop({
    pass: () => lateCovenantSweep({ ...opts, cursor }),
    intervalMs: opts.intervalMs ?? LATE_SWEEP_INTERVAL_MS,
    onError: (err) => console.warn("covenant late sweep: pass failed; retrying:", err),
    immediate: true,
  });
}
