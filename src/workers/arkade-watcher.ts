// Arkade settlement watcher for destination-rail records (LUD-XX paymentOptions).
// The payer pays the user's Arkade address directly, so the server only learns about
// settlement by watching the indexer: a record flips when a VTXO covering the agreed
// amount arrives at the destination after the record was created. The observed
// Arkade txid becomes `paymentReference` on the verify response.

import { hex } from "@scure/base";
import { ArkAddress, RestIndexerProvider, isContractVtxoEvent, type IContractManager, type IndexerProvider } from "@arkade-os/sdk";
import type { SettlementStore } from "../settlement-store.js";

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
    // The pending set is every non-lightning rail, and this watcher owns one of
    // them. An onchain destination is a Bitcoin address that cannot decode as an
    // Arkade one, so reporting it as a failure was permanent noise — and a pass
    // that reports anything also suppresses the clean-pass reset, so it could
    // bury a real indexer outage for the whole seven-day destination window.
    if (p.paymentOption !== "arkade") continue;
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

/** The scripts a pass would read, under the same filter. */
function pendingScripts(store: SettlementStore): string[] {
  const scripts = new Set<string>();
  for (const p of store.listPendingDestinations()) {
    if (p.covenantScript !== null || p.paymentOption !== "arkade") continue;
    try {
      scripts.add(hex.encode(ArkAddress.decode(p.paymentDestination).pkScript));
    } catch { /* undecodable is the pass's to report, not the watch's */ }
  }
  return [...scripts];
}

export interface ArkadeWatcherHandle {
  trigger(): void;
  /** Register a destination the instant it is issued, ahead of the resync. */
  watch(destination: string): void;
  stop(): void;
}

export interface ArkadeWatcherOptions {
  /** Absent, or on a manager without `watchScript`, this degrades to the catch-up. */
  contracts?: IContractManager;
  indexer?: IndexerProvider;
  /** How often the watched set is re-derived. A local read; re-registering is a
   *  no-op, so the network is touched only on a change. */
  syncMs?: number;
}

/**
 * Settle destination payments, driven by VTXO activity at the watched addresses,
 * with a catch-up behind it.
 *
 * `watchScript` rides the contract manager's subscription; a second one loses the
 * race for arkd's stream and reports an EventSource error for the process's life.
 * The watch only ever calls `trigger` — which record a payment belongs to stays in
 * {@link settleDestinationPayments}, unchanged.
 */
export function startArkadeWatcher(
  store: SettlementStore,
  arkServerUrl: string,
  catchUpIntervalMs: number,
  opts: ArkadeWatcherOptions = {},
): ArkadeWatcherHandle {
  const indexer = opts.indexer ?? new RestIndexerProvider(arkServerUrl);
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
  let queued = false;
  let stopped = false;
  let next: ReturnType<typeof setTimeout> | undefined;

  const schedule = (): void => {
    if (stopped) return;
    next = setTimeout(() => pass(), catchUpIntervalMs);
    // Don't keep the process alive just for the catch-up.
    next.unref?.();
  };
  const pass = (): void => {
    if (stopped) return;
    inFlight = true;
    let failed = false;
    void settleDestinationPayments(store, indexer, (stage, err) => {
      failed = true;
      onFailure(stage, err);
    }).finally(() => {
      if (!failed) lastReported = undefined;
      inFlight = false;
      if (queued && !stopped) {
        queued = false;
        pass();
        return;
      }
      schedule();
    });
  };
  const trigger = (): void => {
    if (stopped) return;
    // Queued rather than dropped: the running pass may have read the indexer
    // before this payment landed.
    if (inFlight) queued = true;
    else {
      if (next) clearTimeout(next);
      pass();
    }
  };

  const watching = new Set<string>();
  const contracts = opts.contracts;
  const canWatch = Boolean(contracts?.watchScript && contracts.unwatchScript);
  const register = async (scripts: string[]): Promise<void> => {
    const added = scripts.filter((s) => !watching.has(s));
    if (added.length === 0) return;
    // Recorded BEFORE the call: registering re-announces what is already at the
    // script, during the await. A destination can be paid before this resolves,
    // so that announcement IS the payment — adding after dropped it.
    for (const s of added) watching.add(s);
    try {
      await contracts!.watchScript!(added, { label: "lnurl-destination" });
    } catch (err) {
      for (const s of added) watching.delete(s);
      throw err;
    }
  };

  /** Watch a destination as it is handed out. The resync would find it within a
   *  tick, but the payer does not wait for one — and an arrival at a script not
   *  yet registered is only found by the catch-up, fifteen seconds later. */
  const watch = (destination: string): void => {
    if (stopped || !canWatch) return;
    let script: string;
    try {
      script = hex.encode(ArkAddress.decode(destination).pkScript);
    } catch {
      return;
    }
    void register([script]).catch((err) => onFailure("watch registration", err));
  };

  const syncWatched = async (): Promise<void> => {
    if (stopped || !canWatch) return;
    try {
      const want = new Set(pendingScripts(store));
      await register([...want]);
      const gone = [...watching].filter((s) => !want.has(s));
      if (gone.length > 0) {
        await contracts!.unwatchScript!(gone);
        for (const s of gone) watching.delete(s);
      }
    } catch (err) {
      onFailure("watch registration", err);
    }
  };

  const unsubscribe = canWatch
    ? contracts!.onContractEvent((event) => {
        if (event.type !== "vtxo_received") return;
        // A contract's own event belongs to another watcher; ours carry none.
        if (isContractVtxoEvent(event) || !watching.has(event.contractScript)) return;
        trigger();
      })
    : undefined;

  // On its own clock: a destination handed out at T would otherwise stay unwatched
  // until the pass that settles it anyway.
  const resync = canWatch ? setInterval(() => void syncWatched(), opts.syncMs ?? 1000) : undefined;
  resync?.unref?.();
  void syncWatched();

  pass();
  return {
    trigger,
    watch,
    stop: () => {
      stopped = true;
      queued = false;
      if (next) clearTimeout(next);
      if (resync) clearInterval(resync);
      unsubscribe?.();
    },
  };
}
