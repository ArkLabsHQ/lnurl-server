import type { PaymentSyncStore, StoredPayment } from "./sync.js";

export interface LnurlPaymentStore {
  read(): Promise<StoredPayment[]>;
  /** Insert or replace by key, leaving records absent from the batch untouched. */
  write(records: StoredPayment[]): Promise<void>;
  clear(): Promise<void>;
}

export interface LnurlPaymentWatermarkStore {
  read(baseUrl: string, lightningAddress: string): Promise<number | undefined>;
  write(baseUrl: string, lightningAddress: string, since: number): Promise<void>;
  clear(): Promise<void>;
}

export interface LnurlPaymentRepository extends PaymentSyncStore {
  all(): Promise<StoredPayment[]>;
  /** Explicit purge; use clearLnurlPaymentsForReset to close and drain writers first. */
  clear(): Promise<void>;
  closeWrites(): void;
  reopenWrites(): void;
  writesClosed(): boolean;
  writesSettled(): Promise<void>;
}

export function createLnurlPaymentRepository(
  payments: LnurlPaymentStore,
  watermarks: LnurlPaymentWatermarkStore,
): LnurlPaymentRepository {
  const inFlight = new Set<Promise<void>>();
  let closed = false;

  const write = async (work: () => Promise<void>): Promise<void> => {
    if (closed) return;
    // Register before invoking an injected backend, including one that throws synchronously.
    const pending = Promise.resolve().then(work);
    inFlight.add(pending);
    try {
      await pending;
    } finally {
      inFlight.delete(pending);
    }
  };

  return {
    all: () => payments.read(),
    upsert: (records) => write(() => payments.write(records)),
    readWatermark: (baseUrl, address) => watermarks.read(baseUrl, address),
    writeWatermark: (baseUrl, address, since) => write(() => watermarks.write(baseUrl, address, since)),
    clear: async () => {
      // Separate backends cannot clear atomically; losing a cursor first permits safe replay.
      await watermarks.clear();
      await payments.clear();
    },
    closeWrites: () => { closed = true; },
    reopenWrites: () => { closed = false; },
    writesClosed: () => closed,
    writesSettled: async () => { await Promise.allSettled([...inFlight]); },
  };
}

export async function clearLnurlPaymentsForReset(repository: LnurlPaymentRepository): Promise<void> {
  repository.closeWrites();
  try {
    await repository.writesSettled();
    await repository.clear();
  } catch (error) {
    repository.reopenWrites();
    throw error;
  }
}
