import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { DbSettlementStore } from "../../src/settlement-store.js";

describe("DbSettlementStore", () => {
  it("persists across store instances (DB-backed, not instance state)", () => {
    const db = openDb(":memory:");
    runMigrations(db);

    const a = new DbSettlementStore(db, 60_000);
    a.create({ paymentHash: "aa", pr: "lnbc1", sessionId: "sess" });
    expect(a.markSettled("aa", "beef")).toBe(true);

    const b = new DbSettlementStore(db, 60_000);
    expect(b.get("aa")).toMatchObject({ settled: true, preimage: "beef", pr: "lnbc1", sessionId: "sess" });

    db.close();
  });

  it("is idempotent on create and returns false for unknown markSettled", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const s = new DbSettlementStore(db, 60_000);
    s.create({ paymentHash: "bb", pr: "lnbc1", sessionId: "sess" });
    s.create({ paymentHash: "bb", pr: "OTHER", sessionId: "x" });
    expect(s.get("bb")!.pr).toBe("lnbc1");
    expect(s.markSettled("missing", "pre")).toBe(false);
    db.close();
  });

  it("refuses a second markSettled rather than overwriting the settled preimage", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const s = new DbSettlementStore(db, 60_000);
    s.create({ paymentHash: "cc", pr: "lnbc1", sessionId: "sess" });
    expect(s.markSettled("cc", "beef")).toBe(true);
    expect(s.markSettled("cc", "d00d")).toBe(false);
    expect(s.get("cc")!.preimage).toBe("beef");
    db.close();
  });

  it("holds an offline swap's preimage + swapId and lists pending across instances", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const a = new DbSettlementStore(db, 60_000);
    a.create({ paymentHash: "aa", pr: "lnbc1", sessionId: "off:1", preimage: "beef", swapId: "swap-1" });
    const b = new DbSettlementStore(db, 60_000);
    expect(b.listPendingSwaps()).toEqual([{ swapId: "swap-1", paymentHash: "aa", preimage: "beef" }]);
    expect(b.get("aa")).toMatchObject({ settled: false, preimage: "beef", swapId: "swap-1" });
    b.markSettled("aa", "beef");
    expect(b.listPendingSwaps()).toEqual([]);
    db.close();
  });

  it("persists a non-pr (destination) record with option fields", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const a = new DbSettlementStore(db, 60_000);
    a.create({ paymentHash: "vid1", pr: "", sessionId: "sess", paymentOption: "arkade", paymentDestination: "ark1xyz", amountMsat: 50000 });
    const b = new DbSettlementStore(db, 60_000);
    expect(b.get("vid1")).toMatchObject({
      settled: false,
      paymentOption: "arkade",
      paymentDestination: "ark1xyz",
      paymentReference: null,
      amountMsat: 50000,
    });
    // A legacy lightning record (no option column) reads back as "lightning".
    a.create({ paymentHash: "aa", pr: "lnbc1", sessionId: "sess" });
    expect(b.get("aa")!.paymentOption).toBe("lightning");
    db.close();
  });

  it("lists pending destinations and marks them observed, across instances", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    let t = 1000;
    const a = new DbSettlementStore(db, 5000, () => t);
    a.create({ paymentHash: "vid1", pr: "", sessionId: "sess", paymentOption: "arkade", paymentDestination: "ark1xyz", amountMsat: 50000 });
    a.create({ paymentHash: "vid2", pr: "", sessionId: "sess", paymentOption: "arkade", paymentDestination: "ark1xyz" }); // no amount
    a.create({ paymentHash: "aa", pr: "lnbc1", sessionId: "sess" });
    const b = new DbSettlementStore(db, 5000, () => t);
    expect(b.listPendingDestinations()).toEqual([{ paymentHash: "vid1", paymentDestination: "ark1xyz", amountMsat: 50000, createdAt: 1000 }]);
    expect(b.markObserved("vid1", "txid1")).toBe(true);
    expect(b.get("vid1")).toMatchObject({ settled: true, paymentReference: "txid1", preimage: null });
    // Idempotent: a second observation never overwrites the reference.
    expect(b.markObserved("vid1", "txid2")).toBe(false);
    expect(b.get("vid1")!.paymentReference).toBe("txid1");
    expect(b.listPendingDestinations()).toEqual([]);
    t = 1000 + 5000;
    const c = new DbSettlementStore(db, 5000, () => t);
    c.create({ paymentHash: "vid9", pr: "", sessionId: "sess", paymentOption: "arkade", paymentDestination: "ark1xyz", amountMsat: 1, });
    expect(c.listPendingDestinations().map((d) => d.paymentHash)).toEqual(["vid9"]);
    t += 5001;
    expect(c.listPendingDestinations()).toEqual([]);
    db.close();
  });

  it("expires records past the ttl", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    let t = 1000;
    const s = new DbSettlementStore(db, 5000, () => t);
    s.create({ paymentHash: "cc", pr: "lnbc1", sessionId: "sess" });
    expect(s.get("cc")).toBeDefined();
    t = 1000 + 5000;
    expect(s.get("cc")).toBeUndefined();
    db.close();
  });

  it("stops listing pending swaps once their record is past the ttl", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    let t = 1000;
    const s = new DbSettlementStore(db, 5000, () => t);
    s.create({ paymentHash: "dd", pr: "lnbc1", sessionId: "off:1", preimage: "beef", swapId: "swap-1" });
    expect(s.listPendingSwaps()).toHaveLength(1);
    t = 1000 + 5000;
    expect(s.listPendingSwaps()).toEqual([]);
    db.close();
  });
});
