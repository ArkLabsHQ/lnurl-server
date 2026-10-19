import { describe, expect, it, vi } from "vitest";
import {
  clearLnurlPaymentsForReset,
  createLnurlPaymentRepository,
  type LnurlPaymentStore,
  type LnurlPaymentWatermarkStore,
} from "../src/repository.js";
import { syncPayments, type StoredPayment } from "../src/sync.js";
import type { PaymentPage } from "../src/types.js";

const SERVER = "https://lnurl.example";
const ADDRESS = "alice@example.com";
const payment = (identifier: string, extra: Partial<StoredPayment> = {}): StoredPayment => ({
  key: `${SERVER}|${identifier}`, baseUrl: SERVER, domain: "example.com", lightningAddress: ADDRESS,
  handle: "alice", identifier, kind: "bolt11", settled: true, amountMsat: 1000, createdAt: 100,
  settledAt: 101, swapId: null, paymentReference: null, payoutReference: null, preimage: null,
  paymentOption: null, covenantScript: null, ...extra,
});

const memory = (): { payments: LnurlPaymentStore; watermarks: LnurlPaymentWatermarkStore } => {
  const records = new Map<string, StoredPayment>();
  const cursors = new Map<string, number>();
  return {
    payments: {
      read: async () => [...records.values()],
      write: async (rows) => { for (const row of rows) records.set(row.key, row); },
      clear: async () => { records.clear(); },
    },
    watermarks: {
      read: async (baseUrl, address) => cursors.get(`${baseUrl}|${address}`),
      write: async (baseUrl, address, since) => { cursors.set(`${baseUrl}|${address}`, since); },
      clear: async () => { cursors.clear(); },
    },
  };
};

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe("payment repository", () => {
  it("upserts by key without losing unrelated records or mixing servers", async () => {
    const { payments, watermarks } = memory();
    const repository = createLnurlPaymentRepository(payments, watermarks);
    await repository.upsert([payment("one", { settled: false }), payment("two")]);
    await repository.upsert([payment("one"), payment("one", { key: "other|one", baseUrl: "other" })]);

    expect(await repository.all()).toEqual([payment("one"), payment("two"), payment("one", {
      key: "other|one", baseUrl: "other",
    })]);
  });

  it("isolates cursors by server and address", async () => {
    const { payments, watermarks } = memory();
    const store = createLnurlPaymentRepository(payments, watermarks);
    expect(await store.readWatermark(SERVER, ADDRESS)).toBeUndefined();
    await store.writeWatermark(SERVER, ADDRESS, 42);
    await store.writeWatermark("other", ADDRESS, 7);
    await store.writeWatermark(SERVER, "bob@example.com", 9);

    expect(await store.readWatermark(SERVER, ADDRESS)).toBe(42);
    expect(await store.readWatermark("other", ADDRESS)).toBe(7);
    expect(await store.readWatermark(SERVER, "bob@example.com")).toBe(9);
  });

  it("closes the gate synchronously and can reopen it", async () => {
    const { payments, watermarks } = memory();
    payments.write = vi.fn(payments.write);
    watermarks.write = vi.fn(watermarks.write);
    const repository = createLnurlPaymentRepository(payments, watermarks);
    const store = repository;
    repository.closeWrites();
    expect(repository.writesClosed()).toBe(true);
    await Promise.all([store.upsert([payment("late")]), store.writeWatermark(SERVER, ADDRESS, 42)]);
    expect(payments.write).not.toHaveBeenCalled();
    expect(watermarks.write).not.toHaveBeenCalled();

    repository.reopenWrites();
    expect(repository.writesClosed()).toBe(false);
    await store.upsert([payment("fresh")]);
    expect(await repository.all()).toEqual([payment("fresh")]);
  });

  it.each(["record", "watermark"] as const)("drains accepted %s writes including immediate close", async (kind) => {
    const { payments, watermarks } = memory();
    const held = deferred();
    if (kind === "record") payments.write = () => held.promise;
    else watermarks.write = () => held.promise;
    const repository = createLnurlPaymentRepository(payments, watermarks);
    const pending = kind === "record"
      ? repository.upsert([payment("one")])
      : repository.writeWatermark(SERVER, ADDRESS, 42);
    repository.closeWrites();
    let settled = false;
    const drain = repository.writesSettled().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    held.resolve();
    await Promise.all([pending, drain]);
    expect(settled).toBe(true);
  });

  it.each(["record", "watermark"] as const)("propagates rejected %s writes without hanging the drain", async (kind) => {
    const { payments, watermarks } = memory();
    const held = deferred();
    if (kind === "record") payments.write = () => held.promise;
    else watermarks.write = () => held.promise;
    const repository = createLnurlPaymentRepository(payments, watermarks);
    const pending = kind === "record"
      ? repository.upsert([payment("one")])
      : repository.writeWatermark(SERVER, ADDRESS, 42);
    const failed = expect(pending).rejects.toThrow("offline");
    repository.closeWrites();
    const drain = repository.writesSettled();
    held.reject(new Error("offline"));
    await failed;
    await expect(drain).resolves.toBeUndefined();
  });

  it("turns a synchronous backend throw into a rejected write", async () => {
    const { payments, watermarks } = memory();
    payments.write = () => { throw new Error("storage unavailable"); };
    const repository = createLnurlPaymentRepository(payments, watermarks);
    await expect(repository.upsert([payment("one")])).rejects.toThrow("storage unavailable");
    await expect(repository.writesSettled()).resolves.toBeUndefined();
  });
});

describe("payment reset", () => {
  it("drains both backends before clearing and refuses all late writers", async () => {
    const { payments, watermarks } = memory();
    const heldRecords = deferred();
    const heldWatermarks = deferred();
    const order: string[] = [];
    const writeRecords = payments.write;
    const writeWatermark = watermarks.write;
    const clearRecords = payments.clear;
    const clearWatermarks = watermarks.clear;
    payments.write = async (rows) => { await heldRecords.promise; await writeRecords(rows); order.push("record"); };
    watermarks.write = async (base, address, since) => {
      await heldWatermarks.promise;
      await writeWatermark(base, address, since);
      order.push("watermark");
    };
    payments.clear = async () => { order.push("clear records"); await clearRecords(); };
    watermarks.clear = async () => { order.push("clear watermarks"); await clearWatermarks(); };
    const repository = createLnurlPaymentRepository(payments, watermarks);
    const syncStore = repository;
    const record = syncStore.upsert([payment("secret", { preimage: "ab".repeat(32) })]);
    const watermark = syncStore.writeWatermark(SERVER, ADDRESS, 42);
    const reset = clearLnurlPaymentsForReset(repository);
    heldRecords.resolve();
    await record;
    expect(order).toEqual(["record"]);
    heldWatermarks.resolve();
    await Promise.all([watermark, reset]);
    await syncStore.upsert([payment("late")]);
    await syncStore.writeWatermark(SERVER, ADDRESS, 100);

    expect(order).toEqual(["record", "watermark", "clear watermarks", "clear records"]);
    expect(await repository.all()).toEqual([]);
    expect(await syncStore.readWatermark(SERVER, ADDRESS)).toBeUndefined();
    expect(repository.writesClosed()).toBe(true);
  });

  it("keeps records when watermark clear fails and reopens both writers", async () => {
    const { payments, watermarks } = memory();
    const repository = createLnurlPaymentRepository(payments, watermarks);
    await repository.upsert([payment("secret")]);
    await repository.writeWatermark(SERVER, ADDRESS, 42);
    watermarks.clear = async () => { throw new Error("watermark clear failed"); };

    await expect(clearLnurlPaymentsForReset(repository)).rejects.toThrow("watermark clear failed");
    expect(await repository.all()).toEqual([payment("secret")]);
    expect(await repository.readWatermark(SERVER, ADDRESS)).toBe(42);
    expect(repository.writesClosed()).toBe(false);
    await repository.upsert([payment("new")]);
    await repository.writeWatermark(SERVER, ADDRESS, 43);
    expect(await repository.all()).toHaveLength(2);
    expect(await repository.readWatermark(SERVER, ADDRESS)).toBe(43);
  });

  it("reopens after record clear fails, leaving no cursor that could skip recovery", async () => {
    const { payments, watermarks } = memory();
    const repository = createLnurlPaymentRepository(payments, watermarks);
    await repository.upsert([payment("secret")]);
    await repository.writeWatermark(SERVER, ADDRESS, 42);
    payments.clear = async () => { throw new Error("record clear failed"); };

    await expect(clearLnurlPaymentsForReset(repository)).rejects.toThrow("record clear failed");
    expect(await repository.all()).toEqual([payment("secret")]);
    expect(await repository.readWatermark(SERVER, ADDRESS)).toBeUndefined();
    expect(repository.writesClosed()).toBe(false);
  });

  it("still clears after an accepted write rejects", async () => {
    const { payments, watermarks } = memory();
    const held = deferred();
    watermarks.write = () => held.promise;
    const repository = createLnurlPaymentRepository(payments, watermarks);
    await repository.upsert([payment("secret")]);
    const rejected = expect(repository.writeWatermark(SERVER, ADDRESS, 42)).rejects.toThrow("offline");
    const reset = clearLnurlPaymentsForReset(repository);
    held.reject(new Error("offline"));
    await rejected;
    await reset;
    expect(await repository.all()).toEqual([]);
    expect(repository.writesClosed()).toBe(true);
  });
});

describe("repository sync", () => {
  it("persists inclusive pagination and resumes through the injected cursors", async () => {
    const { payments, watermarks } = memory();
    const repository = createLnurlPaymentRepository(payments, watermarks);
    const store = repository;
    const rows = [100, 101, 102].map((createdAt) => ({
      kind: "bolt11" as const, paymentHash: String(createdAt), pr: "lnbc-test", preimage: null,
      swapId: null, payoutReference: null, settled: true, amountMsat: 1000, createdAt, settledAt: createdAt,
    }));
    const listPayments = vi.fn(async (_token: string, _handle: string, options?: { since?: number; limit?: number }) => {
      const page = rows.filter((row) => row.createdAt >= (options?.since ?? 0)).slice(0, options?.limit ?? 50);
      return {
        source: { domain: "example.com", lightningAddress: ADDRESS, handle: "alice" },
        payments: page, nextSince: page.at(-1)?.createdAt ?? options?.since ?? 0,
      } satisfies PaymentPage;
    });
    const target = { baseUrl: SERVER, token: "token", handle: "alice", domain: "example.com" };

    expect(await syncPayments([target], { client: () => ({ listPayments }), store, limit: 2 }))
      .toEqual({ synced: 5, failures: [] });
    expect(await repository.all()).toHaveLength(3);
    expect(await store.readWatermark(SERVER, ADDRESS)).toBe(102);
    listPayments.mockClear();
    expect(await syncPayments([target], { client: () => ({ listPayments }), store, limit: 2 }))
      .toEqual({ synced: 1, failures: [] });
    expect(listPayments).toHaveBeenCalledWith("token", "alice", { domain: "example.com", since: 102, limit: 2 });
  });
});
