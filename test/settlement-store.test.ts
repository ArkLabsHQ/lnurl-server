import { describe, it, expect } from "vitest";
import { MemorySettlementStore } from "../src/settlement-store.js";

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
});
