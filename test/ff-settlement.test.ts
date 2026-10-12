import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { createHash } from "node:crypto";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { DbSettlementStore } from "../src/settlement-store.js";
import { OfflineSwapStore } from "../src/offline-swap-store.js";
import { FfOrderStore } from "../src/ff-order-store.js";
import { createServer } from "../src/http/server.js";
import { createLogger } from "../src/logger.js";
import { settleOfflineSwaps } from "../src/workers/offline-poller.js";
import { ffReferenceOnSettle } from "../src/workers/ff-order-poller.js";
import { chainTxid } from "../src/rails/fixedfloat/catalogue.js";
import { FfBudget, ffAuth, ffClient, ffHttpTransport, type FfClient } from "../src/rails/fixedfloat/client.js";
import type { OfflineSwapCreator } from "../src/services/offline-swaps.js";
import { fakeFixedFloat, type FakeFf } from "./helpers/fake-fixedfloat.js";

const PREIMAGE = "11".repeat(32);
const HASH = createHash("sha256").update(Buffer.from(PREIMAGE, "hex")).digest("hex");
const DEPOSIT_TXID = "0x" + "de".repeat(32);
const quiet = createLogger({ info: () => {}, warn: () => {}, error: () => {} });

let db: Db; let ff: FakeFf; let client: FfClient; let orders: FfOrderStore; let settlements: DbSettlementStore; let swaps: OfflineSwapStore;
let orderId: string;
const servers: http.Server[] = [];

const corridor = (opts: { settled?: boolean; claimTxid?: string } = {}): OfflineSwapCreator => ({
  create: async () => { throw new Error("unused"); },
  isSettled: async () => opts.settled ?? true,
  ...(opts.claimTxid ? { selfClaim: async () => ({ state: "claimed" as const, arkTxid: opts.claimTxid! }) } : {}),
});

const settle = (creator: OfflineSwapCreator) =>
  settleOfflineSwaps(settlements, creator, swaps, quiet, { onSettled: ffReferenceOnSettle({ orders, client, logger: quiet }) });

const orderCalls = () => ff.calls.filter((c) => c.method === "order").length;

async function verify(): Promise<Record<string, unknown>> {
  const server = http.createServer(createServer({ port: 0, baseUrl: "http://x", minSendable: 1_000, maxSendable: 100_000_000 }, { repos: undefined as never, settlements }));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return (await fetch(`http://127.0.0.1:${port}/lnurl/verify/${HASH}`)).json() as Promise<Record<string, unknown>>;
}

beforeEach(async () => {
  db = openDb(":memory:"); runMigrations(db);
  ff = await fakeFixedFloat();
  client = ffClient({ transport: ffHttpTransport({ baseUrl: ff.baseUrl, auth: ffAuth(ff.apiKey, ff.secret) }), budget: new FfBudget() });
  const order = await client.create({ fromCcy: "USDTARBITRUM", toSat: 10_000, toAddress: "lnbc100u1fake" }, client.reserveCreate()!);
  orderId = order.id;
  ff.calls.length = 0;
  orders = new FfOrderStore(db, 86_400_000);
  settlements = new DbSettlementStore(db, 86_400_000);
  swaps = new OfflineSwapStore(db, 86_400_000);
  orders.createAccepted({
    paymentHash: HASH, pr: "lnbc100u1fake", sessionId: "offline:1", preimage: PREIMAGE, amountMsat: 10_000_000, paymentOption: "ff-usdtarbitrum",
    recovery: { version: 1, solverName: "s", solverPubkey: "11".repeat(32), relays: ["wss://relay.example"], rfqId: "rfq-1", lockupAddress: "tark1x", expectedAmount: 9_980, script: {} },
    order: { id: order.id, token: order.token, ffCode: "USDTARBITRUM", asset: "eip155:42161/erc20:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", unit: "USDT",
      depositAddress: order.from.address, depositAmount: "8426000", invoiceAmountSat: 10_000, status: "NEW", expiresAt: order.expiresAt! },
  });
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
  await ff.close();
  db.close();
});

const reportDeposit = (txid: string | null, status = "DONE") => {
  const order = ff.orders.get(orderId)!;
  order.status = status;
  order.from.tx = { ...order.from.tx, id: txid };
};

describe("token-deposit settlement", () => {
  it("settles an ff- row from the corridor with the recorded deposit txid as its reference", async () => {
    orders.recordStatus(HASH, { status: "PENDING", depositTxid: DEPOSIT_TXID });
    expect(await settle(corridor())).toBe(1);
    expect(settlements.get(HASH)).toMatchObject({ settled: true, paymentReference: DEPOSIT_TXID });
    expect(orderCalls()).toBe(0);
  });

  it("verify returns the deposit txid as paymentReference", async () => {
    reportDeposit(DEPOSIT_TXID);
    await settle(corridor());
    expect(await verify()).toEqual({
      status: "OK", settled: true, paymentOption: "ff-usdtarbitrum", paymentDestination: ff.orders.get(orderId)!.from.address,
      paymentReference: DEPOSIT_TXID, verifyBatch: "http://x/lnurl/verifyBatch",
    });
  });

  it("fetches the order once at settle time when the deposit txid is still missing", async () => {
    reportDeposit(DEPOSIT_TXID);
    await settle(corridor());
    expect(orderCalls()).toBe(1);
    expect(orders.byPaymentHash(HASH)).toMatchObject({ status: "DONE", depositTxid: DEPOSIT_TXID });
    expect(settlements.get(HASH)?.paymentReference).toBe(DEPOSIT_TXID);
  });

  it("settles with no reference when FixedFloat has not reported the deposit, and fills it once it does", async () => {
    reportDeposit(null, "EXCHANGE");
    await settle(corridor());
    expect(settlements.get(HASH)).toMatchObject({ settled: true, paymentReference: null });
    expect(orders.listOpen().map((o) => o.orderId)).toEqual([orderId]);
    orders.recordStatus(HASH, { status: "DONE", depositTxid: DEPOSIT_TXID });
    expect(settlements.get(HASH)?.paymentReference).toBe(DEPOSIT_TXID);
  });

  it("keeps the self-claim arkTxid in payoutReference, never in paymentReference", async () => {
    reportDeposit(DEPOSIT_TXID);
    await settle(corridor({ claimTxid: "ab".repeat(32) }));
    expect(settlements.get(HASH)).toMatchObject({ settled: true, paymentReference: DEPOSIT_TXID, payoutReference: "ab".repeat(32) });
  });

  it("verify answers settled: false and no reference before settlement, even with the deposit known", async () => {
    orders.recordStatus(HASH, { status: "PENDING", depositTxid: DEPOSIT_TXID });
    expect(await verify()).toMatchObject({ settled: false, paymentReference: null });
  });

  it("an ff- row never settles from an FF order status alone", async () => {
    reportDeposit(DEPOSIT_TXID);
    orders.recordStatus(HASH, { status: "DONE", depositTxid: DEPOSIT_TXID });
    expect(await settle(corridor({ settled: false }))).toBe(0);
    expect(settlements.get(HASH)).toMatchObject({ settled: false, paymentReference: null });
  });

  it("a lightning row still settles through markSettled and still reveals its preimage", async () => {
    const preimage = "22".repeat(32);
    const hash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
    swaps.createAccepted({ paymentHash: hash, pr: "lnbc1", sessionId: "offline:1", preimage, amountMsat: 5_000_000,
      recovery: { version: 1, solverName: "s", solverPubkey: "11".repeat(32), relays: ["wss://relay.example"], rfqId: "rfq-2", lockupAddress: "tark1y", expectedAmount: 4_990, script: {} } });
    await settle(corridor());
    expect(settlements.get(hash)).toMatchObject({ settled: true, preimage, paymentOption: "lightning", paymentReference: null });
  });

  it("normalises the deposit txid to its chain's own shape", () => {
    const hex = "de".repeat(32);
    expect(chainTxid("eip155", hex)).toBe(`0x${hex}`);
    expect(chainTxid("eip155", `0x${hex}`)).toBe(`0x${hex}`);
    expect(chainTxid("tron", `0x${hex}`)).toBe(hex);
    expect(chainTxid("tron", hex)).toBe(hex);
    const signature = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
    expect(chainTxid("solana", signature)).toBe(signature);
    expect(chainTxid("solana", hex)).toBeUndefined();
    expect(chainTxid("eip155", "not-a-txid")).toBeUndefined();
  });
});
