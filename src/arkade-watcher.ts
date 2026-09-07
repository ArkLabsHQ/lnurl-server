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
 *  arrival window is the record's TTL expiry, not the skew. A transient indexer
 *  failure skips that destination for the next pass. */
export const SETTLEMENT_SKEW_MS = 15_000;
/** Reports a pass that could not complete. Nothing here retries — the next tick does. */
export type WatcherFailure = (stage: string, err: unknown) => void;

export async function settleDestinationPayments(
  store: SettlementStore,
  indexer: IndexerProvider,
  onFailure: WatcherFailure = () => {},
): Promise<number> {
  const pending = store.listPendingDestinations();
  let settled = 0;

  // No correlation needed: the script belongs to one record, so a VTXO there is
  // that record's payment. The amount check stays — an under-payment must not flip
  // `settled`. No isReferenceUsed either: one tx paying two records through two
  // outputs is legitimate here, and that guard would refuse the second.
  const owned = pending.filter((p) => p.covenantScript !== null);
  if (owned.length > 0) {
    try {
      const byScript = new Map(owned.map((p) => [p.covenantScript!, p]));
      const { vtxos } = await indexer.getVtxos({ scripts: [...byScript.keys()] });
      for (const v of vtxos) {
        const record = byScript.get(v.script);
        if (!record || v.value * 1000 < record.amountMsat) continue;
        if (store.markObserved(record.paymentHash, v.txid)) settled++;
      }
    } catch (err) {
      // Written for an unreachable indexer, but a misconfigured one lands here too
      // and never leaves: silently, the rail simply stops settling.
      onFailure("covenant lookup", err);
    }
  }

  // The rest share a static address, where the correlation below is all there is.
  const byDestination = new Map<string, typeof pending>();
  for (const p of pending) {
    if (p.covenantScript !== null) continue;
    const group = byDestination.get(p.paymentDestination) ?? [];
    group.push(p);
    byDestination.set(p.paymentDestination, group);
  }

  for (const [destination, records] of byDestination) {
    let script: string;
    try {
      script = hex.encode(ArkAddress.decode(destination).pkScript);
    } catch (err) {
      onFailure(`undecodable destination ${destination}`, err);
      continue;
    }
    try {
      const oldest = Math.min(...records.map((r) => r.createdAt));
      // `after` is a coarse server-side filter (wire unit is seconds); the
      // authoritative comparison is the local one below, in milliseconds.
      const { vtxos } = await indexer.getVtxos({ scripts: [script], after: Math.floor((oldest - SETTLEMENT_SKEW_MS) / 1000) });
      const arrivals = vtxos
        .filter((v) => v.createdAt.getTime() >= oldest - SETTLEMENT_SKEW_MS)
        // A txid that already settled a record must not settle another one later.
        .filter((v) => !store.isReferenceUsed(v.txid))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const assigned = new Set<string>();
      for (const record of records.sort((a, b) => a.createdAt - b.createdAt)) {
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
    } catch (err) {
      onFailure(`static-address lookup for ${destination}`, err);
    }
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
