import { LnurlError } from "./errors.js";
import type { PaymentSyncStore, StoredPayment } from "./sync.js";

const RECORDS = "arkade-lnurl.payments";
const WATERMARKS = "arkade-lnurl.watermarks";

const area = (): Storage => {
  if (typeof localStorage === "undefined") {
    throw new LnurlError("browserPaymentStore needs localStorage; supply your own PaymentSyncStore");
  }
  return localStorage;
};

const read = <T>(key: string, fallback: T): T => {
  try {
    const raw = area().getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

/** A `PaymentSyncStore` over `localStorage`. Synchronous, a few megabytes, and it
 *  rewrites every record per upsert — back a real wallet with IndexedDB instead. */
export function browserPaymentStore(prefix = ""): PaymentSyncStore {
  const records = `${prefix}${RECORDS}`;
  const marks = `${prefix}${WATERMARKS}`;
  return {
    async upsert(incoming) {
      // Replace, never append: what makes the inclusive cursor idempotent.
      const byKey = new Map(read<StoredPayment[]>(records, []).map((r) => [r.key, r]));
      for (const record of incoming) byKey.set(record.key, record);
      area().setItem(records, JSON.stringify([...byKey.values()]));
    },
    async readWatermark(baseUrl, lightningAddress) {
      return read<Record<string, number>>(marks, {})[`${baseUrl}|${lightningAddress}`];
    },
    async writeWatermark(baseUrl, lightningAddress, since) {
      const all = read<Record<string, number>>(marks, {});
      all[`${baseUrl}|${lightningAddress}`] = since;
      area().setItem(marks, JSON.stringify(all));
    },
  };
}

/** Everything synced for one address, newest first. A nameless receiver has no
 *  lightning address to match on, so name it by `{ domain, handle }` instead. */
export function storedPayments(
  address: string | { domain: string; handle: string },
  prefix = "",
): StoredPayment[] {
  const mine = typeof address === "string"
    ? (r: StoredPayment) => r.lightningAddress === address
    : (r: StoredPayment) => r.domain === address.domain && (r.handle === address.handle
      // Synced before records carried a handle, and the per-handle watermark never refetches them.
      || (r.handle === undefined && r.lightningAddress === `${address.handle}@${address.domain}`));
  return read<StoredPayment[]>(`${prefix}${RECORDS}`, [])
    .filter(mine)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function forgetStoredPayments(prefix = ""): void {
  area().removeItem(`${prefix}${RECORDS}`);
  area().removeItem(`${prefix}${WATERMARKS}`);
}
