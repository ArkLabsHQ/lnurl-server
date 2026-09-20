import { describe, it, expect } from "vitest";
import { DbSettlementStore, MemorySettlementStore, type SettlementStore } from "../src/settlement-store.js";
import { openDb } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";

/** Both stores: a drift would leave one deployment's activity silently unlabelled. */
const stores: Array<[string, () => SettlementStore]> = [
  ["MemorySettlementStore", () => new MemorySettlementStore(86_400_000)],
  ["DbSettlementStore", () => { const db = openDb(":memory:"); runMigrations(db); return new DbSettlementStore(db, 86_400_000); }],
];

describe.each(stores)("%s payout references", (_name, make) => {
  it("credits the static rail from the observed payment itself", () => {
    const s = make();
    s.create({ paymentHash: "v1", pr: "", sessionId: "s", paymentOption: "arkade", paymentDestination: "ark1x", amountMsat: 1000 });
    expect(s.markObserved("v1", "tx-a")).toBe(true);
    expect(s.get("v1")).toMatchObject({ paymentReference: "tx-a", payoutReference: "tx-a" });
  });

  it("leaves a covenant payment uncredited until its sweep", () => {
    const s = make();
    s.create({ paymentHash: "v2", pr: "", sessionId: "s", paymentOption: "arkade", paymentDestination: "ark1x", amountMsat: 1000, covenantScript: "0014beef" });
    expect(s.markObserved("v2", "covenant-tx")).toBe(true);
    // Observed at the covenant script, which the user's wallet never holds.
    expect(s.get("v2")).toMatchObject({ paymentReference: "covenant-tx", payoutReference: null });

    expect(s.markPaidOut("v2", "sweep-tx")).toBe(true);
    expect(s.get("v2")).toMatchObject({ paymentReference: "covenant-tx", payoutReference: "sweep-tx" });
  });

  it("keeps the first credit, so a repeated sweep pass cannot rewrite it", () => {
    const s = make();
    s.create({ paymentHash: "v3", pr: "", sessionId: "s", paymentOption: "arkade", paymentDestination: "ark1x", amountMsat: 1000, covenantScript: "0014cafe" });
    expect(s.markPaidOut("v3", "sweep-1")).toBe(true);
    expect(s.markPaidOut("v3", "sweep-2")).toBe(false);
    expect(s.get("v3")).toMatchObject({ payoutReference: "sweep-1" });
    expect(s.markPaidOut("unknown", "tx")).toBe(false);
  });

  it("credits a lightning swap from its claim", () => {
    const s = make();
    s.create({ paymentHash: "aa", pr: "lnbc1", sessionId: "s", swapId: "rfq-1", preimage: "bb" });
    expect(s.get("aa")).toMatchObject({ payoutReference: null });
    expect(s.markPaidOut("aa", "claim-tx")).toBe(true);
    expect(s.get("aa")).toMatchObject({ payoutReference: "claim-tx" });
  });

  it("finds a covenant record after it has settled, which the pending lookup cannot", () => {
    const s = make();
    s.create({ paymentHash: "v4", pr: "", sessionId: "s", paymentOption: "arkade", paymentDestination: "ark1x", amountMsat: 1000, covenantScript: "0014feed" });
    s.markObserved("v4", "covenant-tx");
    expect(s.pendingByCovenantScript("0014feed")).toBeUndefined();
    expect(s.findByCovenantScript("0014feed")).toMatchObject({ paymentHash: "v4" });
    expect(s.findByCovenantScript("0014none")).toBeUndefined();
  });
});

describe("MemorySettlementStore", () => {

  it("creates, settles, and expires", () => {
    let t = 1000;
    const s = new MemorySettlementStore(5000, () => t);

    s.create({ paymentHash: "aa", pr: "lnbc1", sessionId: "sess" });
    expect(s.get("aa")).toMatchObject({ settled: false, preimage: null, pr: "lnbc1", sessionId: "sess" });

    // create is idempotent — a second create for the same hash must not overwrite
    s.create({ paymentHash: "aa", pr: "OTHER", sessionId: "x" });
    expect(s.get("aa")!.pr).toBe("lnbc1");

    expect(s.markSettled("missing", "pre")).toBe(false);
    expect(s.markSettled("aa", "deadbeef")).toBe(true);
    expect(s.get("aa")).toMatchObject({ settled: true, preimage: "deadbeef", settledAt: 1000 });

    t = 1000 + 5000; // reach ttl → record is gone
    expect(s.get("aa")).toBeUndefined();
  });

  it("holds an offline swap's preimage + swapId and lists it until settled", () => {
    const s = new MemorySettlementStore(60_000, () => 1000);
    s.create({ paymentHash: "aa", pr: "lnbc1", sessionId: "off:1", preimage: "beef", swapId: "swap-1" });
    // Preimage is held on the record (verify exposure is gated on `settled` at the route).
    expect(s.get("aa")).toMatchObject({ settled: false, preimage: "beef", swapId: "swap-1" });
    expect(s.listPendingSwaps()).toEqual([{ swapId: "swap-1", paymentHash: "aa", preimage: "beef" }]);
    s.markSettled("aa", "beef");
    expect(s.listPendingSwaps()).toEqual([]);
  });

  it("stops listing pending swaps once their record is past TTL", () => {
    let t = 1000;
    const s = new MemorySettlementStore(5000, () => t);
    s.create({ paymentHash: "aa", pr: "lnbc1", sessionId: "off:1", preimage: "beef", swapId: "swap-1" });
    expect(s.listPendingSwaps()).toHaveLength(1);
    t = 1000 + 5000;
    expect(s.listPendingSwaps()).toEqual([]);
  });

  it("holds a non-pr (destination) record and defaults lightning records to `lightning`", () => {
    const s = new MemorySettlementStore(60_000, () => 1000);
    s.create({ paymentHash: "vid1", pr: "", sessionId: "sess", paymentOption: "arkade", paymentDestination: "ark1xyz", amountMsat: 50000 });
    expect(s.get("vid1")).toMatchObject({
      settled: false,
      paymentOption: "arkade",
      paymentDestination: "ark1xyz",
      paymentReference: null,
      amountMsat: 50000,
    });
    // Records without an explicit option are lightning.
    s.create({ paymentHash: "aa", pr: "lnbc1", sessionId: "sess" });
    expect(s.get("aa")).toMatchObject({ paymentOption: "lightning", paymentDestination: null, amountMsat: null });
  });

  it("lists pending destination records and marks them observed with a reference", () => {
    let t = 1000;
    const s = new MemorySettlementStore(5000, () => t);
    s.create({ paymentHash: "vid1", pr: "", sessionId: "sess", paymentOption: "arkade", paymentDestination: "ark1xyz", amountMsat: 50000 });
    s.create({ paymentHash: "vid2", pr: "", sessionId: "sess", paymentOption: "arkade", paymentDestination: "ark1xyz" }); // no amount
    s.create({ paymentHash: "aa", pr: "lnbc1", sessionId: "sess" }); // lightning

    expect(s.listPendingDestinations()).toEqual([{ paymentHash: "vid1", paymentDestination: "ark1xyz", amountMsat: 50000, createdAt: 1000, paymentOption: "arkade", covenantScript: null }]);

    expect(s.markObserved("missing", "tx")).toBe(false);
    expect(s.markObserved("vid1", "txid1")).toBe(true);
    // The static rail's payment lands at the user, so observing it IS the credit.
    expect(s.get("vid1")).toMatchObject({ settled: true, paymentReference: "txid1", payoutReference: "txid1", preimage: null });
    // A second observation never overwrites the first's reference.
    expect(s.markObserved("vid1", "txid2")).toBe(false);
    expect(s.get("vid1")).toMatchObject({ paymentReference: "txid1" });
    expect(s.listPendingDestinations()).toEqual([]);

    // expired records are not listed
    const s2 = new MemorySettlementStore(5000, () => t);
    s2.create({ paymentHash: "vid9", pr: "", sessionId: "sess", paymentOption: "arkade", paymentDestination: "ark1xyz", amountMsat: 1 });
    t = 1000 + 5000;
    expect(s2.listPendingDestinations()).toEqual([]);
  });

  it("lists recent records newest-first for the admin view", () => {
    let t = 1000;
    const s = new MemorySettlementStore(60_000, () => t);
    s.create({ paymentHash: "a1", pr: "ln1", sessionId: "s" });
    t = 2000;
    s.create({ paymentHash: "a2", pr: "ln2", sessionId: "s", preimage: "beef", swapId: "swap-1" });
    t = 3000;
    s.create({ paymentHash: "a3", pr: "", sessionId: "s", paymentOption: "arkade", paymentDestination: "ark1x", amountMsat: 50 });
    expect(s.listRecent(10).map((r) => r.paymentHash)).toEqual(["a3", "a2", "a1"]);
    expect(s.listRecent(2).map((r) => r.paymentHash)).toEqual(["a3", "a2"]);
  });
});
