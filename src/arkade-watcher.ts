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
 *  {@link SETTLEMENT_SKEW_MS} before its creation. A transient indexer failure skips
 *  that destination for the next pass. */
export const SETTLEMENT_SKEW_MS = 15_000;
export async function settleDestinationPayments(store: SettlementStore, indexer: IndexerProvider): Promise<number> {
  const pending = store.listPendingDestinations();
  const byDestination = new Map<string, typeof pending>();
  for (const p of pending) {
    const group = byDestination.get(p.paymentDestination) ?? [];
    group.push(p);
    byDestination.set(p.paymentDestination, group);
  }

  let settled = 0;
  for (const [destination, records] of byDestination) {
    let script: string;
    try {
      script = hex.encode(ArkAddress.decode(destination).pkScript);
    } catch {
      continue; // undecodable destination — should not happen (validated at registration)
    }
    try {
      const oldest = Math.min(...records.map((r) => r.createdAt));
      // `after` is a coarse server-side filter (wire unit is seconds); the
      // authoritative comparison is the local one below, in milliseconds.
      const { vtxos } = await indexer.getVtxos({ scripts: [script], after: Math.floor((oldest - SETTLEMENT_SKEW_MS) / 1000) });
      const arrivals = vtxos
        .filter((v) => v.createdAt.getTime() >= oldest - SETTLEMENT_SKEW_MS)
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
    } catch {
      // Indexer unreachable / error — leave everything pending for the next tick.
    }
  }
  return settled;
}

/** Run {@link settleDestinationPayments} on an interval. Returns a stop function. */
export function startArkadeWatcher(store: SettlementStore, arkServerUrl: string, intervalMs: number): () => void {
  const indexer = new RestIndexerProvider(arkServerUrl);
  let inFlight = false;
  const timer = setInterval(() => {
    // A slow indexer must not stack overlapping passes.
    if (inFlight) return;
    inFlight = true;
    void settleDestinationPayments(store, indexer).finally(() => {
      inFlight = false;
    });
  }, intervalMs);
  // Don't keep the process alive just for polling.
  timer.unref?.();
  return () => clearInterval(timer);
}
