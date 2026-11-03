// The tail behind the attribution window, for a payer who pays a per-payment covenant
// destination after it lapses. Money only — the record stays unsettled and lapsed,
// because re-attributing it would contradict what every caller was already told.
// A full cycle is ceil(n / LATE_SWEEP_PER_PASS) intervals, which must stay well inside a
// coin's batch expiry: only v3 has a renewal path once that passes.

import type { IndexerProvider } from "@arkade-os/sdk";
import type { LapsedCovenant, SettlementStore } from "../settlement-store.js";
import type { CovenantSweeper } from "./covenant-sweeper.js";
import { startCatchUpLoop, type CatchUpLoop } from "./catch-up-loop.js";

/** Scripts per indexer read, matching src/services/reconcile.ts. */
const DISCOVERY_CHUNK = 32;

/** Rows read and scripts examined per pass, then the gap between passes. */
export const LATE_SWEEP_PER_PASS = 256;
export const LATE_SWEEP_INTERVAL_MS = 600_000;

/** Keyset, not an offset: the tail gains and loses rows between passes, so an index
 *  would silently skip whatever had shifted past it. */
export interface LateSweepCursor {
  after?: LapsedCovenant;
}

export interface LateSweepOptions {
  settlements: SettlementStore;
  indexer: Pick<IndexerProvider, "getVtxos">;
  sweeper: Pick<CovenantSweeper, "sweep">;
  tailMs: number;
  cursor?: LateSweepCursor;
  budget?: number;
}

export async function lateCovenantSweep(opts: LateSweepOptions): Promise<number> {
  const cursor = opts.cursor ?? {};
  const budget = opts.budget ?? LATE_SWEEP_PER_PASS;
  const page = opts.settlements.listLapsedCovenantScripts(opts.tailMs, {
    limit: budget,
    ...(cursor.after ? { after: cursor.after } : {}),
  });
  // A short page is the end of the tail, so the next pass starts over at the oldest.
  if (page.length < budget) delete cursor.after;
  else cursor.after = page[page.length - 1];
  if (page.length === 0) return 0;

  const slice = page.map((r) => r.covenantScript);
  const funded: string[] = [];
  for (let i = 0; i < slice.length; i += DISCOVERY_CHUNK) {
    const chunk = slice.slice(i, i + DISCOVERY_CHUNK);
    try {
      // Spendable or recoverable: an expired deposit counts, a swept one is spent.
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
