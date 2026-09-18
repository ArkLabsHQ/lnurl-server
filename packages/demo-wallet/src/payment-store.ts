import type { PaymentSyncStore, StoredPayment } from "@arkade-os/lnurl-client";

const RECORDS_KEY = "arkade-demo-wallet.payments";
const WATERMARK_KEY = "arkade-demo-wallet.payment-watermarks";

const read = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

/**
 * `PaymentSyncStore` over localStorage.
 *
 * The client package ships no storage on purpose — IndexedDB exists in neither
 * Node nor React Native — so a consumer supplies one. localStorage is enough
 * for a demo and wrong for a real wallet: it is synchronous, small, and
 * rewrites every record on each upsert.
 *
 * `upsert` replaces by `key` rather than appending, which is what makes a
 * re-sync across the inclusive cursor boundary idempotent instead of
 * duplicating the boundary row.
 */
export function localPaymentStore(): PaymentSyncStore {
  return {
    async upsert(records) {
      const byKey = new Map(read<StoredPayment[]>(RECORDS_KEY, []).map((r) => [r.key, r]));
      for (const record of records) byKey.set(record.key, record);
      localStorage.setItem(RECORDS_KEY, JSON.stringify([...byKey.values()]));
    },
    async readWatermark(baseUrl, lightningAddress) {
      return read<Record<string, number>>(WATERMARK_KEY, {})[`${baseUrl}|${lightningAddress}`];
    },
    async writeWatermark(baseUrl, lightningAddress, since) {
      const marks = read<Record<string, number>>(WATERMARK_KEY, {});
      marks[`${baseUrl}|${lightningAddress}`] = since;
      localStorage.setItem(WATERMARK_KEY, JSON.stringify(marks));
    },
  };
}

/** Everything synced for one address, newest first. */
export function storedPayments(lightningAddress: string): StoredPayment[] {
  return read<StoredPayment[]>(RECORDS_KEY, [])
    .filter((r) => r.lightningAddress === lightningAddress)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function forgetPayments(): void {
  localStorage.removeItem(RECORDS_KEY);
  localStorage.removeItem(WATERMARK_KEY);
}
