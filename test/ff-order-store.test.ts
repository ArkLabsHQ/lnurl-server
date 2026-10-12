import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { DbSettlementStore } from "../src/settlement-store.js";
import { FfOrderStore, type AcceptedFfOrder } from "../src/ff-order-store.js";

const TTL = 60_000;
let db: Db;
let now: number;
let orders: FfOrderStore;
let settlements: DbSettlementStore;

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
  now = 1_000_000;
  orders = new FfOrderStore(db, TTL, () => now);
  settlements = new DbSettlementStore(db, TTL, () => now);
});
afterEach(() => db.close());

function accepted(hash: string, overrides: Partial<AcceptedFfOrder["order"]> = {}): AcceptedFfOrder {
  return {
    paymentHash: hash,
    pr: "lnbc100u1fake",
    sessionId: "offline:1",
    preimage: "bb".repeat(32),
    amountMsat: 10_000_000,
    paymentOption: "ff-usdtarbitrum",
    recovery: {
      version: 1, solverName: "solver", solverPubkey: "11".repeat(32), relays: ["wss://relay.example"],
      rfqId: `rfq-${hash}`, lockupAddress: "tark1lockup", expectedAmount: 9_980, script: {},
    },
    order: {
      id: `ID${hash.slice(0, 4)}`, token: "secret-order-token", ffCode: "USDTARBITRUM",
      asset: "eip155:42161/erc20:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", unit: "USDT",
      depositAddress: "0x" + "ab".repeat(20), depositAmount: "8426000", invoiceAmountSat: 10_000, status: "NEW", expiresAt: 1_000 + 900,
      ...overrides,
    },
  };
}

describe("FfOrderStore", () => {
  it("createAccepted writes the settlement and order rows atomically", () => {
    orders.createAccepted(accepted("aa".repeat(32)));
    expect(settlements.get("aa".repeat(32))).toMatchObject({
      paymentOption: "ff-usdtarbitrum", paymentDestination: "0x" + "ab".repeat(20), amountMsat: 10_000_000,
      swapId: "rfq-" + "aa".repeat(32), settled: false, paymentReference: null,
    });
    expect(orders.byPaymentHash("aa".repeat(32))).toMatchObject({ orderId: "IDaaaa", token: "secret-order-token", depositAmount: "8426000", status: "NEW", depositTxid: null });
    expect(db.prepare("SELECT rfq_id FROM offline_swaps").all()).toEqual([{ rfq_id: "rfq-" + "aa".repeat(32) }]);
  });

  it("createAccepted rolls back the settlement row when the order insert fails", () => {
    orders.createAccepted(accepted("aa".repeat(32)));
    // Same FixedFloat order id: the unique index refuses the order row last.
    expect(() => orders.createAccepted({ ...accepted("cc".repeat(32)), order: accepted("aa".repeat(32)).order })).toThrow();
    expect(settlements.get("cc".repeat(32))).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM offline_swaps").get()).toEqual({ n: 1 });
  });

  it("listOpen keeps EXPIRED, which a late deposit can still revive, and excludes DONE and rows past the ttl", () => {
    for (const [hash, status] of [["a1", "NEW"], ["a2", "PENDING"], ["a3", "DONE"], ["a4", "EXPIRED"], ["a5", "EMERGENCY"]] as const) {
      orders.createAccepted(accepted(hash.repeat(32), { status }));
    }
    expect(orders.listOpen().map((o) => o.status).sort()).toEqual(["EMERGENCY", "EXPIRED", "NEW", "PENDING"]);
    now += TTL;
    expect(orders.listOpen()).toEqual([]);
  });

  it("keeps polling a finished order whose settled row still waits for its deposit txid", () => {
    orders.createAccepted(accepted("a3".repeat(32), { status: "DONE" }));
    expect(orders.listOpen()).toEqual([]);
    settlements.markSettled("a3".repeat(32), "bb".repeat(32));
    expect(orders.listOpen().map((o) => o.orderId)).toEqual(["IDa3a3"]);
    orders.recordStatus("a3".repeat(32), { status: "DONE", depositTxid: "0x" + "de".repeat(32) });
    expect(orders.listOpen()).toEqual([]);
  });

  it("recordStatus is idempotent for an unchanged status", () => {
    orders.createAccepted(accepted("aa".repeat(32)));
    now += 5_000;
    expect(orders.recordStatus("aa".repeat(32), { status: "PENDING" })).toMatchObject({ changed: true });
    const after = orders.byPaymentHash("aa".repeat(32))!;
    now += 5_000;
    expect(orders.recordStatus("aa".repeat(32), { status: "PENDING" })).toMatchObject({ changed: false });
    expect(orders.byPaymentHash("aa".repeat(32))).toEqual(after);
    expect(orders.recordStatus("ff".repeat(32), { status: "DONE" })).toMatchObject({ changed: false });
  });

  it("records the deposit txid once, and fills only a settled row's missing paymentReference", () => {
    const hash = "aa".repeat(32);
    orders.createAccepted(accepted(hash));
    orders.recordStatus(hash, { status: "PENDING", depositTxid: "0x" + "de".repeat(32) });
    expect(settlements.get(hash)?.paymentReference).toBeNull();
    orders.recordStatus(hash, { status: "PENDING", depositTxid: "0x" + "ad".repeat(32) });
    expect(orders.byPaymentHash(hash)?.depositTxid).toBe("0x" + "de".repeat(32));

    settlements.markSettled(hash, "bb".repeat(32));
    expect(orders.fillReference(hash)).toBe(true);
    expect(settlements.get(hash)).toMatchObject({ settled: true, paymentReference: "0x" + "de".repeat(32), payoutReference: null });
    expect(orders.fillReference(hash)).toBe(false);
  });

  it("counts the orders still awaiting a deposit", () => {
    orders.createAccepted(accepted("a1".repeat(32), { status: "NEW", expiresAt: 2_000 }));
    orders.createAccepted(accepted("a2".repeat(32), { status: "NEW", expiresAt: 900 }));
    orders.createAccepted(accepted("a3".repeat(32), { status: "PENDING", expiresAt: 2_000 }));
    expect(orders.countAwaitingDeposit(1_000)).toBe(1);
  });

  it("deleting a settlement cascades its ff_orders row", () => {
    orders.createAccepted(accepted("aa".repeat(32)));
    db.prepare("DELETE FROM settlements WHERE payment_hash = ?").run("aa".repeat(32));
    expect(orders.byPaymentHash("aa".repeat(32))).toBeUndefined();
  });

  it.each([
    ["listOpen", () => orders.listOpen()],
    ["listUnreferencedPastTtl", () => orders.listUnreferencedPastTtl()],
    ["countAwaitingDeposit", () => orders.countAwaitingDeposit(1_000)],
    ["countAwaitingDeposit for one receiver", () => orders.countAwaitingDeposit(1_000, 1)],
  ])("%s starts from an ff_orders index rather than scanning", (_name, call) => {
    const prepare = db.prepare.bind(db);
    const seen: string[] = [];
    db.prepare = (sql: string) => (seen.push(sql), prepare(sql));
    try {
      call();
    } finally {
      db.prepare = prepare;
    }
    expect(seen).toHaveLength(1);
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${seen[0]}`).all() as { detail: string }[]).map((r) => r.detail);
    expect(plan[0]).toMatch(/^SEARCH f USING INDEX idx_ff_orders_/);
    expect(plan.join(" | ")).not.toContain("SCAN");
  });
});
