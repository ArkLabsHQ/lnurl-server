import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createIndexedDbLnurlPaymentStore,
  createLocalStorageLnurlSentPaymentStore,
  createLocalStorageLnurlWatermarkStore,
} from "../src/browser.js";
import type { LnurlPaymentStore } from "../src/repository.js";
import type { StoredPayment } from "../src/sync.js";

const payment = (identifier: string, extra: Partial<StoredPayment> = {}): StoredPayment => ({
  key: `https://lnurl.example|${identifier}`, baseUrl: "https://lnurl.example", domain: "example.com",
  lightningAddress: "alice@example.com", handle: "alice", identifier, kind: "bolt11", settled: true,
  amountMsat: 1000, createdAt: 100, settledAt: 101, swapId: null, paymentReference: null,
  payoutReference: null, preimage: null, paymentOption: null, covenantScript: null, ...extra,
});

type Outcome = "complete" | "abort" | "error";
type Failure = "transaction" | "objectStore" | "getAll" | "clear" | "secondPut" | "result";
const callback = (): (() => void) | null => null;

function stubIndexedDb({
  initial = [] as StoredPayment[], outcomes = [] as Outcome[], failure = undefined as Failure | undefined,
  openFailure = false, abortThrows = false, existingStore = false,
} = {}) {
  let records = new Map(initial.map((record) => [record.key, record]));
  const error = new DOMException("storage failed", "InvalidStateError");
  const close = vi.fn();
  const abort = vi.fn();
  const createObjectStore = vi.fn(() => { existingStore = true; });
  const transaction = vi.fn(() => {
    if (failure === "transaction") throw error;
    const outcome = outcomes.shift() ?? "complete";
    const pending = new Map(records);
    let aborted = false;
    let puts = 0;
    const tx = {
      error: null as DOMException | null,
      oncomplete: callback(), onerror: callback(), onabort: callback(),
      abort: () => {
        abort();
        aborted = true;
        if (abortThrows) throw error;
        queueMicrotask(() => tx.onabort?.());
      },
      objectStore: () => {
        if (failure === "objectStore") throw error;
        return {
          put: (record: StoredPayment) => {
            if (++puts === 2 && failure === "secondPut") throw error;
            pending.set(record.key, record);
          },
          clear: () => {
            if (failure === "clear") throw error;
            pending.clear();
          },
          getAll: () => {
            if (failure === "getAll") throw error;
            return {
              get result() {
                if (failure === "result") throw error;
                return [...records.values()];
              },
            };
          },
        };
      },
    };
    queueMicrotask(() => {
      if (aborted) return;
      if (outcome === "complete") {
        records = pending;
        tx.oncomplete?.();
      } else {
        if (outcome === "error") {
          tx.onerror?.();
          tx.error = new DOMException("quota exceeded", "QuotaExceededError");
        }
        tx.onabort?.();
      }
    });
    return tx;
  });
  const db = { close, transaction, createObjectStore, objectStoreNames: { contains: () => existingStore } };
  const open = vi.fn(() => {
    const request = {
      result: db, error, onsuccess: callback(), onerror: callback(), onupgradeneeded: callback(),
    };
    queueMicrotask(() => {
      if (openFailure) request.onerror?.();
      else {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      }
    });
    return request;
  });
  vi.stubGlobal("indexedDB", { open });
  return { close, abort, open, transaction, createObjectStore, records: () => [...records.values()] };
}

const operations: [string, (store: LnurlPaymentStore) => Promise<unknown>][] = [
  ["read", (store) => store.read()],
  ["write", (store) => store.write([payment("one")])],
  ["clear", (store) => store.clear()],
];

describe("IndexedDB payment store", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("imports and constructs without IndexedDB in Node", async () => {
    vi.stubGlobal("indexedDB", undefined);
    vi.resetModules();
    const browser = await import("../src/browser.js");
    const store = browser.createIndexedDbLnurlPaymentStore();
    expect(store).toHaveProperty("write");
    await expect(store.read()).rejects.toBeInstanceOf(Error);
  });

  it("uses the existing wallet database schema", async () => {
    const idb = stubIndexedDb();
    await createIndexedDbLnurlPaymentStore().read();
    expect(idb.open).toHaveBeenCalledWith("arkade-lnurl-payments", 1);
    expect(idb.createObjectStore).toHaveBeenCalledWith("payments", { keyPath: "key" });
    expect(idb.transaction).toHaveBeenCalledWith("payments", "readonly");
  });

  it("accepts custom names and leaves an existing store intact", async () => {
    const idb = stubIndexedDb({ existingStore: true });
    await createIndexedDbLnurlPaymentStore("custom", "rows").clear();
    expect(idb.open).toHaveBeenCalledWith("custom", 1);
    expect(idb.transaction).toHaveBeenCalledWith("rows", "readwrite");
    expect(idb.createObjectStore).not.toHaveBeenCalled();
  });

  it("upserts by key, preserves unrelated records, reads, and clears", async () => {
    const idb = stubIndexedDb();
    const store = createIndexedDbLnurlPaymentStore();
    await store.write([payment("one", { settled: false }), payment("two")]);
    await store.write([payment("one"), payment("one", { key: "other|one", baseUrl: "other" })]);
    await expect(store.read()).resolves.toEqual([
      payment("one"), payment("two"), payment("one", { key: "other|one", baseUrl: "other" }),
    ]);
    await store.clear();
    await expect(store.read()).resolves.toEqual([]);
    expect(idb.close).toHaveBeenCalledTimes(5);
  });

  it.each(operations)("rejects a commit-only %s abort and closes the connection", async (_name, call) => {
    const idb = stubIndexedDb({ initial: [payment("old")], outcomes: ["abort"] });
    await expect(call(createIndexedDbLnurlPaymentStore())).rejects.toMatchObject({ name: "AbortError" });
    expect(idb.close).toHaveBeenCalledTimes(1);
    expect(idb.records()).toEqual([payment("old")]);
  });

  it.each(operations)("uses the final transaction error for a failed %s", async (_name, call) => {
    const idb = stubIndexedDb({ outcomes: ["error"] });
    await expect(call(createIndexedDbLnurlPaymentStore())).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(idb.close).toHaveBeenCalledTimes(1);
  });

  it.each(operations)("closes when %s transaction setup throws", async (_name, call) => {
    const idb = stubIndexedDb({ failure: "transaction" });
    await expect(call(createIndexedDbLnurlPaymentStore())).rejects.toMatchObject({ name: "InvalidStateError" });
    expect(idb.close).toHaveBeenCalledTimes(1);
  });

  it.each<Failure>(["objectStore", "getAll", "clear"])("aborts and closes when %s throws", async (failure) => {
    const idb = stubIndexedDb({ failure });
    const store = createIndexedDbLnurlPaymentStore();
    await expect(failure === "clear" ? store.clear() : store.read()).rejects.toMatchObject({ name: "InvalidStateError" });
    expect(idb.abort).toHaveBeenCalledTimes(1);
    expect(idb.close).toHaveBeenCalledTimes(1);
  });

  it("aborts a partially queued write when the second put throws", async () => {
    const idb = stubIndexedDb({ initial: [payment("old")], failure: "secondPut" });
    await expect(createIndexedDbLnurlPaymentStore().write([payment("one"), payment("two")]))
      .rejects.toMatchObject({ name: "InvalidStateError" });
    expect(idb.records()).toEqual([payment("old")]);
    expect(idb.abort).toHaveBeenCalledTimes(1);
    expect(idb.close).toHaveBeenCalledTimes(1);
  });

  it("still settles and closes if abort throws after a synchronous failure", async () => {
    const idb = stubIndexedDb({ failure: "secondPut", abortThrows: true });
    await expect(createIndexedDbLnurlPaymentStore().write([payment("one"), payment("two")]))
      .rejects.toMatchObject({ name: "InvalidStateError" });
    expect(idb.close).toHaveBeenCalledTimes(1);
  });

  it("rejects a read result failure after closing the connection", async () => {
    const idb = stubIndexedDb({ failure: "result" });
    await expect(createIndexedDbLnurlPaymentStore().read()).rejects.toMatchObject({ name: "InvalidStateError" });
    expect(idb.close).toHaveBeenCalledTimes(1);
  });

  it.each(operations)("rejects %s when opening fails", async (_name, call) => {
    const idb = stubIndexedDb({ openFailure: true });
    await expect(call(createIndexedDbLnurlPaymentStore())).rejects.toMatchObject({ name: "InvalidStateError" });
    expect(idb.transaction).not.toHaveBeenCalled();
  });
});

const stubStorage = (initial: Record<string, string> = {}) => {
  const entries = new Map(Object.entries(initial));
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => entries.get(k) ?? null,
    setItem: (k: string, v: string) => void entries.set(k, v),
    removeItem: (k: string) => void entries.delete(k),
  });
  return entries;
};

describe("localStorage watermark store", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps each server and address's cursor in one map under its key, and clears only that key", async () => {
    const entries = stubStorage({ unrelated: "kept" });
    const marks = createLocalStorageLnurlWatermarkStore("marks");
    await marks.write("https://a", "alice@x", 5);
    await marks.write("https://b", "alice@x", 7);
    await expect(marks.read("https://a", "alice@x")).resolves.toBe(5);
    expect(JSON.parse(entries.get("marks")!)).toEqual({ "https://a|alice@x": 5, "https://b|alice@x": 7 });
    await marks.clear();
    expect([...entries.keys()]).toEqual(["unrelated"]);
  });

  it.each([["an absent map", undefined], ["null", "null"], ["an array", "[]"], ["a number", "5"], ["unparseable JSON", "{x"], ["a string cursor", '{"https://a|alice@x":"5"}']])(
    "reads %s as no cursor, and a write replaces it",
    async (_shape, raw) => {
      const entries = stubStorage(raw === undefined ? {} : { marks: raw });
      const marks = createLocalStorageLnurlWatermarkStore("marks");
      await expect(marks.read("https://a", "alice@x")).resolves.toBeUndefined();
      await marks.write("https://a", "alice@x", 9);
      expect(JSON.parse(entries.get("marks")!)).toEqual({ "https://a|alice@x": 9 });
    },
  );

  it("reads unreadable storage as no cursor but rejects a write storage refuses", async () => {
    const refused = new DOMException("denied", "SecurityError");
    vi.stubGlobal("localStorage", { getItem: () => { throw refused; }, setItem: () => { throw refused; } });
    const marks = createLocalStorageLnurlWatermarkStore();
    await expect(marks.read("https://a", "alice@x")).resolves.toBeUndefined();
    await expect(marks.write("https://a", "alice@x", 1)).rejects.toBe(refused);
  });
});

describe("localStorage sent-payment store", () => {
  afterEach(() => vi.unstubAllGlobals());
  const sent = { txid: "t1", target: "alice@pay.example", railId: "lnurl-arkade", amountSat: 1, feeSat: 0, createdAt: 1 };

  it("keeps the records as one JSON array under its key", () => {
    const entries = stubStorage({ unrelated: "kept" });
    const store = createLocalStorageLnurlSentPaymentStore("sends");
    store.write([sent]);
    expect(store.read()).toEqual([sent]);
    expect(JSON.parse(entries.get("sends")!)).toEqual([sent]);
    expect(entries.get("unrelated")).toBe("kept");
  });

  it.each([["nothing stored", undefined], ["null", "null"], ["an object", "{}"], ["a number", "42"], ["unparseable JSON", "{x"]])(
    "reads %s as no sends, without rewriting it",
    (_shape, raw) => {
      const entries = stubStorage(raw === undefined ? {} : { sends: raw });
      expect(createLocalStorageLnurlSentPaymentStore("sends").read()).toEqual([]);
      expect(entries.get("sends")).toBe(raw);
    },
  );

  it("throws a write storage refuses, for the tracker to report", () => {
    const refused = new DOMException("full", "QuotaExceededError");
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw refused; } });
    expect(() => createLocalStorageLnurlSentPaymentStore().write([sent])).toThrow(refused);
  });
});
