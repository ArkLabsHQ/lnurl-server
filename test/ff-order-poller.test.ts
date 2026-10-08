import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { DbSettlementStore } from "../src/settlement-store.js";
import { FfOrderStore } from "../src/ff-order-store.js";
import { createLogger, type Logger } from "../src/logger.js";
import { pollFfOrders } from "../src/workers/ff-order-poller.js";
import { FfBudget, ffAuth, ffClient, ffHttpTransport, type FfClient } from "../src/rails/fixedfloat/client.js";
import { fakeFixedFloat, fail, type FakeFf } from "./helpers/fake-fixedfloat.js";

let db: Db; let ff: FakeFf; let client: FfClient; let budget: FfBudget; let orders: FfOrderStore; let settlements: DbSettlementStore;
let lines: { level: string; event: string; [k: string]: unknown }[]; let logger: Logger;

async function open(hash: string): Promise<string> {
  const order = await client.create({ fromCcy: "USDTARBITRUM", toSat: 10_000, toAddress: "lnbc100u1fake" }, client.reserveCreate()!);
  orders.createAccepted({
    paymentHash: hash, pr: "lnbc100u1fake", sessionId: "offline:1", preimage: "bb".repeat(32), amountMsat: 10_000_000, paymentOption: "ff-usdtarbitrum",
    recovery: { version: 1, solverName: "s", solverPubkey: "11".repeat(32), relays: ["wss://relay.example"], rfqId: `rfq-${hash}`, lockupAddress: "tark1x", expectedAmount: 9_980, script: {} },
    order: { id: order.id, token: order.token, ffCode: "USDTARBITRUM", asset: "eip155:42161/erc20:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", unit: "USDT",
      depositAddress: order.from.address, depositAmount: "8426000", toAmountSat: 10_000, status: "NEW", expiresAt: order.expiresAt! },
  });
  return order.id;
}
const orderCalls = () => ff.calls.filter((c) => c.method === "order").length;
const poll = () => pollFfOrders({ orders, client, logger });

beforeEach(async () => {
  db = openDb(":memory:"); runMigrations(db);
  ff = await fakeFixedFloat();
  budget = new FfBudget();
  client = ffClient({ transport: ffHttpTransport({ baseUrl: ff.baseUrl, auth: ffAuth(ff.apiKey, ff.secret) }), budget });
  orders = new FfOrderStore(db, 86_400_000);
  settlements = new DbSettlementStore(db, 86_400_000);
  lines = [];
  const sink = (line: string) => lines.push(JSON.parse(line));
  logger = createLogger({ info: sink, warn: sink, error: sink });
});
afterEach(async () => { await ff.close(); db.close(); });

describe("FixedFloat order poller", () => {
  it("records a status transition for an open order", async () => {
    const id = await open("aa".repeat(32));
    ff.orders.get(id)!.status = "PENDING";
    ff.orders.get(id)!.from.tx.id = "de".repeat(32);
    await poll();
    expect(orders.byPaymentHash("aa".repeat(32))).toMatchObject({ status: "PENDING", depositTxid: "0x" + "de".repeat(32) });
  });

  it("logs ff_order_emergency at error with the order id and emergency status array", async () => {
    const id = await open("aa".repeat(32));
    Object.assign(ff.orders.get(id)!, { status: "EMERGENCY", emergency: { status: ["EXPIRED", "LESS"], choice: "NONE", repeat: false } });
    await poll();
    expect(lines).toContainEqual(expect.objectContaining({ level: "error", event: "ff_order_emergency", orderId: id, emergency: ["EXPIRED", "LESS"] }));
    await poll();
    expect(lines.filter((l) => l.event === "ff_order_emergency")).toHaveLength(1);
  });

  it("logs DONE at info and EXPIRED at error", async () => {
    const done = await open("aa".repeat(32));
    const expired = await open("cc".repeat(32));
    ff.orders.get(done)!.status = "DONE";
    ff.orders.get(expired)!.status = "EXPIRED";
    await poll();
    expect(lines).toContainEqual(expect.objectContaining({ level: "info", event: "ff_order_status", orderId: done, status: "DONE" }));
    expect(lines).toContainEqual(expect.objectContaining({ level: "error", event: "ff_order_status", orderId: expired, status: "EXPIRED" }));
  });

  it("stops polling a DONE or EXPIRED order", async () => {
    const done = await open("aa".repeat(32));
    const expired = await open("cc".repeat(32));
    ff.orders.get(done)!.status = "DONE";
    ff.orders.get(expired)!.status = "EXPIRED";
    await poll();
    expect(orderCalls()).toBe(2);
    await poll();
    expect(orderCalls()).toBe(2);
  });

  it("a transient order-call failure leaves the row open for the next pass", async () => {
    const id = await open("aa".repeat(32));
    const real = ff.order;
    ff.order = () => fail(500, "temporarily unavailable");
    await poll();
    expect(orders.listOpen().map((o) => o.orderId)).toEqual([id]);
    expect(lines).toContainEqual(expect.objectContaining({ level: "warn", event: "ff_order_poll_failed", orderId: id }));
    ff.order = real;
    ff.orders.get(id)!.status = "DONE";
    await poll();
    expect(orders.listOpen()).toEqual([]);
  });

  it("ends a pass at an exhausted budget instead of failing every order", async () => {
    await open("aa".repeat(32));
    await open("cc".repeat(32));
    budget.take(250 - budget.used());
    await poll();
    expect(orderCalls()).toBe(0);
    expect(lines.filter((l) => l.event === "ff_order_poll_failed")).toEqual([]);
  });

  it("cannot mark a settlement settled", async () => {
    const id = await open("aa".repeat(32));
    Object.assign(ff.orders.get(id)!, { status: "DONE" });
    ff.orders.get(id)!.from.tx.id = "de".repeat(32);
    await poll();
    expect(settlements.get("aa".repeat(32))).toMatchObject({ settled: false, paymentReference: null });
  });
});
