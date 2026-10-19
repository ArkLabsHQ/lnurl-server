import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("the built IndexedDB adapter commits atomically and settles native aborts", async ({ page }) => {
  const bundle = await readFile(new URL("../../client/dist/browser.js", import.meta.url), "utf8");
  await page.route("https://client-storage.test/**", (route) => route.fulfill({
    contentType: route.request().url().endsWith("browser.js") ? "text/javascript" : "text/html",
    body: route.request().url().endsWith("browser.js") ? bundle : "<!doctype html><title>Client storage</title>",
  }));
  await page.goto("https://client-storage.test/");
  const result = await page.evaluate(async () => {
    const modulePath = "/browser.js";
    const { createIndexedDbLnurlPaymentStore } = await import(modulePath) as typeof import("../../client/src/browser.js");
    const dbName = "client-storage-proof";
    const store = createIndexedDbLnurlPaymentStore(dbName, "payments");
    const record = (identifier: string) => ({
      key: `server|${identifier}`, baseUrl: "server", domain: "example.com", lightningAddress: null,
      handle: "alice", identifier, kind: "bolt11" as const, settled: true, amountMsat: 1000,
      createdAt: 1, settledAt: 2, swapId: null, paymentReference: null, payoutReference: null,
      preimage: null, paymentOption: null, covenantScript: null,
    });
    await store.write([record("one"), record("two")]);
    await store.write([{ ...record("one"), amountMsat: 2000 }]);
    const committed = await store.read();
    let failedBatch = "";
    try {
      await store.write([record("partial"), { ...record("bad"), cannotClone: () => {} } as ReturnType<typeof record>]);
    } catch (error) {
      failedBatch = (error as DOMException).name;
    }
    const afterFailedBatch = await store.read();
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args: Parameters<typeof transaction>) {
      const tx = transaction.apply(this, args);
      queueMicrotask(() => tx.abort());
      return tx;
    };
    let abortError = "";
    try {
      await store.clear();
    } catch (error) {
      abortError = (error as DOMException).name;
    } finally {
      IDBDatabase.prototype.transaction = transaction;
    }
    const afterAbort = await store.read();
    await store.clear();
    const cleared = await store.read();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(dbName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    return { committed, afterFailedBatch, afterAbort, cleared, failedBatch, abortError };
  });
  expect(result.committed.map(({ identifier, amountMsat }) => ({ identifier, amountMsat })))
    .toEqual([{ identifier: "one", amountMsat: 2000 }, { identifier: "two", amountMsat: 1000 }]);
  expect(result.failedBatch).toBe("DataCloneError");
  expect(result.abortError).toBe("AbortError");
  expect(result.afterFailedBatch).toEqual(result.committed);
  expect(result.afterAbort).toEqual(result.committed);
  expect(result.cleared).toEqual([]);
});
