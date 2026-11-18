import type { SatoraSwapSnapshot } from "./satora-sdk.js";

export interface SatoraCheckoutRecord {
  key: string;
  label?: string;
  amountSat: number;
  payTo: string;
  verify: string;
  verifyBatch?: string;
  verifyExpiresAt?: number;
  mnemonic: string;
  createdAt: number;
  swap?: SatoraSwapSnapshot;
  funding?: { txId?: string };
  claim?: { startedAt: number; txId?: string };
  recovery?: { txId?: string; source: "deposit" | "contract" };
}

const STORE = "checkouts";
let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("lnurl-demo-satora", 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "key" });
    request.onerror = () => reject(request.error ?? new Error("Could not open Satora payment storage"));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
  });
  database = opening;
  void opening.catch(() => { if (database === opening) database = undefined; });
  return opening;
}

async function transaction<T>(mode: IDBTransactionMode, requestFor: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode, mode === "readwrite" ? { durability: "strict" } : undefined);
    const request = requestFor(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error ?? new Error("Satora payment storage transaction failed"));
  });
}

export function getCheckout(key: string): Promise<SatoraCheckoutRecord | undefined> {
  return transaction("readonly", (store) => store.get(key));
}

export async function listCheckouts(): Promise<SatoraCheckoutRecord[]> {
  const records: SatoraCheckoutRecord[] = await transaction("readonly", (store) => store.getAll());
  return records.sort((a, b) => b.createdAt - a.createdAt);
}

export async function saveCheckout(record: SatoraCheckoutRecord): Promise<void> {
  await transaction("readwrite", (store) => store.put(record));
}
