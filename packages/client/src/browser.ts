/// <reference lib="dom" />
import type { LnurlPaymentStore } from "./repository.js";
import type { StoredPayment } from "./sync.js";

export function createIndexedDbLnurlPaymentStore(
  dbName = "arkade-lnurl-payments",
  storeName = "payments",
): LnurlPaymentStore {
  const open = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const run = <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => () => T): Promise<T> =>
    open().then((db) => new Promise<T>((resolve, reject) => {
      const fail = (error: unknown) => {
        db.close();
        reject(error ?? new DOMException("Transaction aborted", "AbortError"));
      };
      let started: IDBTransaction | undefined;
      try {
        const tx = db.transaction(storeName, mode);
        started = tx;
        // Commit failures may only fire abort; bubbling request errors precede tx.error.
        tx.onabort = () => fail(tx.error);
        const result = work(tx.objectStore(storeName));
        tx.oncomplete = () => {
          db.close();
          try {
            resolve(result());
          } catch (error) {
            reject(error);
          }
        };
      } catch (error) {
        if (started) {
          // Closing alone would still commit requests queued before work threw.
          started.onabort = () => fail(error);
          try {
            started.abort();
          } catch {
            fail(error);
          }
        } else fail(error);
      }
    }));

  return {
    read: () => run("readonly", (store) => {
      const request = store.getAll();
      return () => request.result as StoredPayment[];
    }),
    write: (records) => run("readwrite", (store) => {
      for (const record of records) store.put(record);
      return () => undefined;
    }),
    clear: () => run("readwrite", (store) => {
      store.clear();
      return () => undefined;
    }),
  };
}
