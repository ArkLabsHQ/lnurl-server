import { hex } from "@scure/base";
import { ArkAddress, type IndexerProvider } from "@arkade-os/sdk";
import type { SettlementStore } from "../settlement-store.js";

/** Scripts per indexer query, matching src/workers/arkade-watcher.ts. Reconciling a
 *  hundred addresses is a sweep, and one read per address would make the
 *  support tool itself the slow part. */
const RECONCILE_CHUNK = 32;
export const RECONCILE_MAX = 200;

export type ReconcileRow = Record<string, unknown> & { addressId: number };

/**
 * Post-mortem: what actually arrived at these addresses, against what the
 * service recorded. For when a user says they were paid and nothing shows it.
 *
 * A destination record stops being watched after DESTINATION_WATCH_MS, so a
 * payment arriving later is never attributed: `verify` answers "not found" and
 * the address history stays blank. The money is not lost — a static Arkade
 * address is the user's own, and a covenant destination is still swept to it,
 * because the sweeper reads the contract manager rather than the settlement
 * store. Only the record lapses, and nothing else here can answer "did it land".
 *
 * Read-only by design. Re-attributing a lapsed payment at an address shared by
 * every payment to it would be guesswork; this exists to inform a human.
 * Shared by the single-address and batch routes so they cannot disagree on
 * what counts as attributed.
 */
export async function reconcileAddresses(
  indexer: Pick<IndexerProvider, "getVtxos">,
  settlements: SettlementStore | undefined,
  rows: { id: number; arkadeAddress: string | null }[],
): Promise<ReconcileRow[]> {
  const out = new Map<number, ReconcileRow>();
  const byScript = new Map<string, { id: number; arkadeAddress: string }[]>();
  for (const row of rows) {
    if (!row.arkadeAddress) {
      out.set(row.id, { addressId: row.id, error: "address has no registered Arkade identity" });
      continue;
    }
    let script: string;
    try {
      script = hex.encode(ArkAddress.decode(row.arkadeAddress).pkScript);
    } catch {
      out.set(row.id, { addressId: row.id, error: "registered Arkade address is undecodable" });
      continue;
    }
    const group = byScript.get(script) ?? [];
    group.push({ id: row.id, arkadeAddress: row.arkadeAddress });
    byScript.set(script, group);
  }

  const scripts = [...byScript.keys()];
  for (let i = 0; i < scripts.length; i += RECONCILE_CHUNK) {
    const chunk = scripts.slice(i, i + RECONCILE_CHUNK);
    let vtxos: { txid: string; vout: number; value: number; createdAt: Date; script: string }[] = [];
    try {
      ({ vtxos } = (await indexer.getVtxos({ scripts: chunk })) as never);
    } catch (err) {
      // A failed chunk costs its own addresses only; the rest of the sweep stands.
      const message = `indexer lookup failed: ${err instanceof Error ? err.message : String(err)}`;
      for (const script of chunk) for (const a of byScript.get(script)!) out.set(a.id, { addressId: a.id, error: message });
      continue;
    }
    const arrivalsByScript = new Map<string, typeof vtxos>();
    for (const v of vtxos) {
      const bucket = arrivalsByScript.get(v.script) ?? [];
      bucket.push(v);
      arrivalsByScript.set(v.script, bucket);
    }
    for (const script of chunk) {
      // One query may answer several addresses: two users can register the
      // same Arkade address, and then the same arrivals belong to both.
      for (const a of byScript.get(script)!) {
        // Matched on the observed reference, which is what a watcher writes when
        // it attributes an arrival — not on amount, which cannot tell two apart.
        const byReference = new Map(
          (settlements?.listByAddress(a.id, 500) ?? [])
            .filter((r) => r.paymentReference)
            .map((r) => [r.paymentReference!, r]),
        );
        const arrivals = (arrivalsByScript.get(script) ?? []).map((v) => {
          const record = byReference.get(v.txid);
          return {
            txid: v.txid,
            vout: v.vout,
            value: v.value,
            createdAt: v.createdAt instanceof Date ? v.createdAt.toISOString() : v.createdAt,
            attributed: Boolean(record),
            ...(record ? { paymentHash: record.paymentHash } : {}),
          };
        });
        out.set(a.id, {
          addressId: a.id,
          arkadeAddress: a.arkadeAddress,
          script,
          arrivals,
          unattributed: arrivals.filter((x) => !x.attributed).length,
        });
      }
    }
  }
  return rows.map((row) => out.get(row.id) ?? { addressId: row.id, error: "address not found" });
}
