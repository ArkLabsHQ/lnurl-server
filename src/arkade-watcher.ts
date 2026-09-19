// Arkade settlement watcher for destination-rail records (LUD-XX paymentOptions).
// The payer pays the user's Arkade address directly, so the server only learns about
// settlement by watching the indexer: a record flips when a VTXO covering the agreed
// amount arrives at the destination after the record was created. The observed
// Arkade txid becomes `paymentReference` on the verify response.

import { hex } from "@scure/base";
import { ArkAddress, RestIndexerProvider, type IndexerProvider } from "@arkade-os/sdk";
import type { SettlementStore } from "./settlement-store.js";

/** One watch pass: flip any pending destination record whose payment is visible at
 *  the indexer. Matching is oldest-record-first with each VTXO assigned at most once;
 *  an under-payment (value*1000 < amountMsat) never flips a record. Payments are
 *  correlated by arrival time, but the wire's `createdAt` is seconds-granular and the
 *  payer can outrun the callback, so a record tolerates arrivals up to
 *  {@link SETTLEMENT_SKEW_MS} before its creation. The effective upper bound on the
 *  arrival window is the record's TTL expiry, not the skew. An indexer failure
 *  calls `onFailure` and skips that destination for the next pass — reported
 *  rather than swallowed, because a misconfigured indexer is indistinguishable
 *  from an unreachable one and never recovers on its own. */
export const SETTLEMENT_SKEW_MS = 15_000;
/** Reports a pass that could not complete. Nothing here retries — the next tick does. */
export type WatcherFailure = (stage: string, err: unknown) => void;

/** Scripts per indexer query. The indexer takes many but a URL is finite, and the
 *  SDK chunks its own multi-script reads at 32 — matched here rather than inventing
 *  a second limit. One read per 32 destinations, not one per destination: a pass
 *  used to cost a round trip per open payment, which saturated its own interval
 *  somewhere around a hundred of them. */
const SCRIPT_QUERY_CHUNK = 32;

export async function settleDestinationPayments(
  store: SettlementStore,
  indexer: IndexerProvider,
  onFailure: WatcherFailure = () => {},
): Promise<number> {
  const pending = store.listPendingDestinations();
  let settled = 0;

  // Keyed by script rather than address: a batched read needs the scripts up
  // front, and every returned vtxo carries the script that regroups it.
  const byScript = new Map<string, typeof pending>();
  for (const p of pending) {
    if (p.covenantScript !== null) continue;
    let script: string;
    try {
      script = hex.encode(ArkAddress.decode(p.paymentDestination).pkScript);
    } catch (err) {
      onFailure(`undecodable destination ${p.paymentDestination}`, err);
      continue;
    }
    const group = byScript.get(script) ?? [];
    group.push(p);
    byScript.set(script, group);
  }

  const scripts = [...byScript.keys()];
  for (let i = 0; i < scripts.length; i += SCRIPT_QUERY_CHUNK) {
    const chunk = scripts.slice(i, i + SCRIPT_QUERY_CHUNK);
    const records = chunk.flatMap((s) => byScript.get(s)!);
    try {
      const oldest = Math.min(...records.map((r) => r.createdAt));
      // `after` is a coarse server-side filter (wire unit is seconds); the
      // authoritative comparison is the local one below, in milliseconds. It
      // widens to the oldest record in the chunk, which only ever returns more.
      const { vtxos } = await indexer.getVtxos({ scripts: chunk, after: Math.floor((oldest - SETTLEMENT_SKEW_MS) / 1000) });
      const arrivalsByScript = new Map<string, typeof vtxos>();
      for (const v of vtxos) {
        const bucket = arrivalsByScript.get(v.script) ?? [];
        bucket.push(v);
        arrivalsByScript.set(v.script, bucket);
      }
      for (const script of chunk) {
        settled += settleAtScript(store, byScript.get(script)!, arrivalsByScript.get(script) ?? []);
      }
    } catch (err) {
      // A failed chunk skips its own destinations only, and the next tick
      // retries them — the same isolation a per-destination read had, coarser.
      onFailure(`static-address lookup for ${chunk.length} destination(s)`, err);
    }
  }
  return settled;
}

/** Correlate one script's arrivals against its pending records. Shared address,
 *  so this is all there is: oldest record first, each VTXO assigned at most once,
 *  and an under-payment never flips anything. */
function settleAtScript(
  store: SettlementStore,
  records: { paymentHash: string; amountMsat: number; createdAt: number }[],
  vtxos: { txid: string; vout: number; value: number; createdAt: Date }[],
): number {
  let settled = 0;
  const oldest = Math.min(...records.map((r) => r.createdAt));
  const arrivals = vtxos
    .filter((v) => v.createdAt.getTime() >= oldest - SETTLEMENT_SKEW_MS)
    // A txid that already settled a record must not settle another one later.
    .filter((v) => !store.isReferenceUsed(v.txid))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const assigned = new Set<string>();
  for (const record of [...records].sort((a, b) => a.createdAt - b.createdAt)) {
    const hit = arrivals.find(
      (v) =>
        !assigned.has(`${v.txid}:${v.vout}`) &&
        v.createdAt.getTime() >= record.createdAt - SETTLEMENT_SKEW_MS &&
        v.value * 1000 >= record.amountMsat,
    );
    if (!hit) continue;
    assigned.add(`${hit.txid}:${hit.vout}`);
    if (store.markObserved(record.paymentHash, hit.txid)) settled++;
  }
  return settled;
}

/** Run {@link settleDestinationPayments} on an interval. Returns a stop function. */
export function startArkadeWatcher(store: SettlementStore, arkServerUrl: string, intervalMs: number): () => void {
  const indexer = new RestIndexerProvider(arkServerUrl);
  let inFlight = false;
  // Deduped: a down indexer fails identically every tick, and a line every
  // intervalMs would bury the first one. Cleared on a clean pass, so a
  // recurrence says so again.
  let lastReported: string | undefined;
  const onFailure: WatcherFailure = (stage, err) => {
    const msg = `${stage}: ${err instanceof Error ? err.message : String(err)}`;
    if (msg === lastReported) return;
    lastReported = msg;
    console.warn(`arkade watcher: ${msg}`);
  };
  const timer = setInterval(() => {
    // A slow indexer must not stack overlapping passes.
    if (inFlight) return;
    inFlight = true;
    let failed = false;
    void settleDestinationPayments(store, indexer, (stage, err) => {
      failed = true;
      onFailure(stage, err);
    }).finally(() => {
      if (!failed) lastReported = undefined;
      inFlight = false;
    });
  }, intervalMs);
  // Don't keep the process alive just for polling.
  timer.unref?.();
  return () => clearInterval(timer);
}
