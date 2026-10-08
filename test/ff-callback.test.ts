import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { ArkAddress } from "@arkade-os/sdk";
import { createServer, type ServerDeps } from "../src/http/server.js";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { AddressService } from "../src/services/addresses.js";
import { DbSettlementStore } from "../src/settlement-store.js";
import { OfflineSwapStore } from "../src/offline-swap-store.js";
import { FfOrderStore } from "../src/ff-order-store.js";
import { FfBudget, ffAuth, ffClient, ffHttpTransport } from "../src/rails/fixedfloat/client.js";
import { ffRates, ffRatesXml } from "../src/rails/fixedfloat/rates.js";
import { FIXEDFLOAT, type FixedFloatDeps } from "../src/rails/fixedfloat/provider.js";
import type { OfflineSwapCreator, OfflineSwapParams, OfflineSwapResult } from "../src/services/offline-swaps.js";
import { fakeFixedFloat, fail, type FakeFf } from "./helpers/fake-fixedfloat.js";
import { buildInvoice } from "./helpers/bolt11.js";

const RECEIVE = new ArkAddress(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), "tark").encode();
const CLAIM_PUBKEY = "02" + "ab".repeat(32);
const SOLVER_FEE_SAT = 20;
const nowSec = () => Math.floor(Date.now() / 1000);

class FakeCorridor implements OfflineSwapCreator {
  created: OfflineSwapParams[] = [];
  deadline = () => nowSec() + 1_800;
  constructor(private events: string[]) {}
  async create(params: OfflineSwapParams): Promise<OfflineSwapResult> {
    this.events.push("corridor");
    this.created.push(params);
    const preimage = randomBytes(32).toString("hex");
    const hash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
    return {
      swapId: `rfq-${hash.slice(0, 16)}`, invoice: buildInvoice(hash, { amountHrp: `${params.amountSat * 10}n` }), preimage, preimageHash: hash,
      lockupAddress: RECEIVE, invoiceExpiresAt: this.deadline(),
      recovery: { version: 1, solverName: "fake", solverPubkey: "11".repeat(32), relays: ["wss://relay.invalid"], rfqId: `rfq-${hash.slice(0, 16)}`,
        lockupAddress: RECEIVE, expectedAmount: params.amountSat - SOLVER_FEE_SAT, script: {} },
    };
  }
  async isSettled(): Promise<boolean> { return false; }
}

let db: Db; let repos: Repositories; let ff: FakeFf; let corridor: FakeCorridor; let budget: FfBudget;
let orders: FfOrderStore; let settlements: DbSettlementStore; let deps: FixedFloatDeps; let events: string[];
const servers: http.Server[] = [];

async function start(extra: Partial<ServerDeps> = {}, withFf = true): Promise<string> {
  const server = http.createServer();
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  server.on("request", createServer(
    { port: 0, baseUrl, minSendable: 1_000, maxSendable: 100_000_000, invoiceTimeoutMs: 3_000 },
    { repos, addressService: new AddressService(repos, randomBytes(32)), settlements, offlineSwaps: new OfflineSwapStore(db, 86_400_000),
      offlineSwapCreator: corridor, ...(withFf ? { fixedFloat: deps } : {}), ...extra },
  ));
  return baseUrl;
}

function get(url: string): Promise<{ status: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: { Host: "domain.com" } }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(d) }));
    }).on("error", reject);
  });
}

const callback = (baseUrl: string, query: string) => get(`${baseUrl}/.well-known/lnurlp/alice/callback?${query}`);

beforeEach(async () => {
  db = openDb(":memory:"); runMigrations(db); repos = createRepositories(db);
  const domainId = repos.domains.create({ domain: "domain.com", allocationModes: ["self"] }).id;
  const address = repos.addresses.create({ domainId, username: "alice", status: "active", sessionId: "s-alice" });
  repos.addresses.setOfflineReceive(address.id, RECEIVE, CLAIM_PUBKEY);
  repos.addresses.setBoardingAddress(address.id, "tb1qboardingaddressexample");
  events = [];
  ff = await fakeFixedFloat();
  for (const method of ["price", "create"] as const) {
    const real = ff[method];
    ff[method] = (body) => { events.push(method); return real(body); };
  }
  corridor = new FakeCorridor(events);
  budget = new FfBudget();
  const client = ffClient({ transport: ffHttpTransport({ baseUrl: ff.baseUrl, auth: ffAuth(ff.apiKey, ff.secret) }), budget });
  const rates = ffRates({ client, fetchRatesXml: ffRatesXml(ff.ratesUrl), idPrefix: "ff-", staleAfterMs: 900_000 });
  await rates.refresh();
  settlements = new DbSettlementStore(db, 86_400_000);
  orders = new FfOrderStore(db, 86_400_000);
  deps = { provider: FIXEDFLOAT, rates, client, orders, settleMarginSeconds: 600, minPayWindowSeconds: 300, maxOpenOrders: 20 };
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
  await ff.close();
  db.close();
});

describe("FixedFloat callback", () => {
  it("answers a destination, a quote and a verify URL for an advertised ff- option", async () => {
    const baseUrl = await start();
    const res = await callback(baseUrl, "amount=10000000&paymentOption=ff-usdtarbitrum");
    const order = [...ff.orders.values()][0]!;
    const hash = settlements.listRecent(1)[0]!.paymentHash;
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "OK",
      paymentOption: "ff-usdtarbitrum",
      paymentDestination: order.from.address,
      paymentURI: `ethereum:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9@42161/transfer?address=${order.from.address}&uint256=8426000`,
      provider: "FixedFloat",
      paymentQuote: {
        id: order.id,
        expiresAt: expect.any(String),
        requested: { amount: "10000000", unit: "msat" },
        payment: { amount: "8426000", unit: "USDT" },
        receive: { amount: "9980000", unit: "msat" },
        fees: [{ name: "provider", amount: { amount: "268000", unit: "msat" } }, { name: "solver", amount: { amount: "20000", unit: "msat" } }],
      },
      verify: `${baseUrl}/lnurl/verify/${hash}`,
      verifyBatch: `${baseUrl}/lnurl/verifyBatch`,
    });
    expect(corridor.created).toEqual([{ amountSat: 10_000, receiveAddress: RECEIVE, claimPublicKey: CLAIM_PUBKEY }]);
    expect(ff.calls.at(-1)?.body).toMatchObject({ type: "fixed", fromCcy: "USDTARBITRUM", toCcy: "BTCLN", direction: "to", amount: 0.0001, toAddress: settlements.get(hash)!.pr });
  });

  it("carries no top-level expiresAt; the quote's is the earlier of FixedFloat's and the invoice's less the margin", async () => {
    const baseUrl = await start();
    const invoiceDeadline = nowSec() + 1_800;
    corridor.deadline = () => invoiceDeadline;
    const res = await callback(baseUrl, "amount=10000000&paymentOption=ff-usdtarbitrum");
    expect(res.body).not.toHaveProperty("expiresAt");
    const ffDeadline = [...ff.orders.values()][0]!.time.expiration as number;
    expect(Date.parse(res.body.paymentQuote.expiresAt) / 1000).toBe(Math.min(ffDeadline, invoiceDeadline - 600));
  });

  it("echoes the requested paymentOption id", async () => {
    const baseUrl = await start();
    expect((await callback(baseUrl, "amount=10000000&paymentOption=FF-USDCSOL")).body.paymentOption).toBe("ff-usdcsol");
  });

  it("refuses an amount outside the option's bounds", async () => {
    const baseUrl = await start();
    const res = await callback(baseUrl, "amount=2843000&paymentOption=ff-usdtarbitrum");
    expect(res.body).toEqual({ status: "ERROR", reason: "Amount must be between 2844000 and 100000000 millisats" });
    expect(events).toEqual([]);
  });

  it("refuses a sub-satoshi amount", async () => {
    const baseUrl = await start();
    expect((await callback(baseUrl, "amount=10000500&paymentOption=ff-usdtarbitrum")).body)
      .toEqual({ status: "ERROR", reason: "Amount must be a whole number of satoshis" });
    expect(events).toEqual([]);
  });

  it("refuses a unit on an ff- option, whose amount is always millisats", async () => {
    const baseUrl = await start();
    expect((await callback(baseUrl, "amount=10000000&unit=USDT&paymentOption=ff-usdtarbitrum")).body)
      .toEqual({ status: "ERROR", reason: "unit is not supported for this paymentOption" });
  });

  it("calls price before creating the corridor swap", async () => {
    const baseUrl = await start();
    await callback(baseUrl, "amount=10000000&paymentOption=ff-usdtarbitrum");
    expect(events).toEqual(["price", "corridor", "create"]);
  });

  it("does not create an FF order when price reports the amount out of range", async () => {
    const baseUrl = await start();
    const real = ff.price;
    ff.price = (body) => {
      const res = real(body) as { data: { errors: string[] } };
      res.data.errors = ["LIMIT_MIN"];
      return res as never;
    };
    const res = await callback(baseUrl, "amount=10000000&paymentOption=ff-usdtarbitrum");
    expect(res.body).toEqual({ status: "ERROR", reason: "Amount is outside what FixedFloat accepts for ff-usdtarbitrum right now" });
    expect(corridor.created).toEqual([]);
    expect(ff.orders.size).toBe(0);
  });

  it("does not create an FF order when the invoice, less the margin, leaves under the minimum pay window", async () => {
    const baseUrl = await start();
    corridor.deadline = () => nowSec() + 800;
    const res = await callback(baseUrl, "amount=10000000&paymentOption=ff-usdtarbitrum");
    expect(res.body).toMatchObject({ status: "ERROR", reason: "paymentOption ff-usdtarbitrum is unavailable for this request" });
    expect(events).toEqual(["price", "corridor"]);
    expect(budget.used()).toBe(2);
  });

  it("serves an order FixedFloat keeps open longer than the invoice allows, quoting the invoice's deadline less the margin", async () => {
    const baseUrl = await start();
    ff.windowSeconds = 1_800;
    const invoiceDeadline = nowSec() + 1_800;
    corridor.deadline = () => invoiceDeadline;
    const res = await callback(baseUrl, "amount=10000000&paymentOption=ff-usdtarbitrum");
    expect(res.body.status).toBe("OK");
    expect(Date.parse(res.body.paymentQuote.expiresAt) / 1000).toBe(invoiceDeadline - 600);
  });

  it("refuses an order that leaves the payer under the minimum pay window", async () => {
    const baseUrl = await start();
    ff.windowSeconds = 200;
    const res = await callback(baseUrl, "amount=10000000&paymentOption=ff-usdtarbitrum");
    expect(res.body).toEqual({ status: "ERROR", reason: "paymentOption ff-usdtarbitrum is unavailable for this request" });
    expect(ff.orders.size).toBe(1);
    expect(settlements.listRecent(10)).toEqual([]);
  });

  it("maps FixedFloat's unroutable-invoice answer (304) to an unavailable option, never a 500", async () => {
    const baseUrl = await start();
    ff.create = () => fail(304, "Invalid route, unable to find a path to destination");
    const res = await callback(baseUrl, "amount=10000000&paymentOption=ff-usdtarbitrum");
    expect(res).toEqual({ status: 200, body: { status: "ERROR", reason: "paymentOption ff-usdtarbitrum is unavailable for this request" } });
    expect(settlements.listRecent(10)).toEqual([]);
  });

  it("refuses when FF's to.amount does not equal the invoice amount", async () => {
    const baseUrl = await start();
    const real = ff.create;
    ff.create = (body) => {
      const res = real(body) as { data: { to: { amount: string } } };
      res.data.to.amount = "0.00010001";
      return res as never;
    };
    expect((await callback(baseUrl, "amount=10000000&paymentOption=ff-usdtarbitrum")).body.status).toBe("ERROR");
    expect(settlements.listRecent(10)).toEqual([]);
  });

  it("refuses when FF's from.amount has more decimals than the token", async () => {
    const baseUrl = await start();
    const real = ff.create;
    ff.create = (body) => {
      const res = real(body) as { data: { from: { amount: string } } };
      res.data.from.amount = "8.4260001";
      return res as never;
    };
    expect((await callback(baseUrl, "amount=10000000&paymentOption=ff-usdtarbitrum")).body.status).toBe("ERROR");
    expect(settlements.listRecent(10)).toEqual([]);
  });

  it("refuses a deposit FixedFloat would need a memo tag for", async () => {
    const baseUrl = await start();
    const real = ff.create;
    ff.create = (body) => {
      const res = real(body) as { data: { from: { tag: string | null } } };
      res.data.from.tag = "123456";
      return res as never;
    };
    expect((await callback(baseUrl, "amount=10000000&paymentOption=ff-usdtarbitrum")).body.status).toBe("ERROR");
    expect(settlements.listRecent(10)).toEqual([]);
  });

  it("refuses with 429 when the FF budget is exhausted", async () => {
    const baseUrl = await start();
    budget.take(201);
    const res = await callback(baseUrl, "amount=10000000&paymentOption=ff-usdtarbitrum");
    expect(res).toEqual({ status: 429, body: { status: "ERROR", reason: "paymentOption ff-usdtarbitrum is busy, try again shortly" } });
    expect(events).toEqual([]);
  });

  it("refuses with 429 at the open-order cap", async () => {
    deps = { ...deps, maxOpenOrders: 1 };
    const baseUrl = await start();
    expect((await callback(baseUrl, "amount=10000000&paymentOption=ff-usdtarbitrum")).body.status).toBe("OK");
    const res = await callback(baseUrl, "amount=10000000&paymentOption=ff-usdtarbitrum");
    expect(res).toEqual({ status: 429, body: { status: "ERROR", reason: "Token deposit capacity reached, try again shortly" } });
  });

  it("writes the settlement and ff_orders rows atomically", async () => {
    const baseUrl = await start();
    await callback(baseUrl, "amount=10000000&paymentOption=ff-usdtarbitrum");
    const [record] = settlements.listRecent(10);
    const order = [...ff.orders.values()][0]!;
    expect(record).toMatchObject({ paymentOption: "ff-usdtarbitrum", paymentDestination: order.from.address, amountMsat: 10_000_000, settled: false });
    expect(orders.byPaymentHash(record!.paymentHash)).toMatchObject({ orderId: order.id, token: order.token, depositAmount: "8426000", toAmountSat: 10_000 });
    expect(db.prepare("SELECT payment_hash FROM offline_swaps").all()).toEqual([{ payment_hash: record!.paymentHash }]);
  });

  it("returns no paymentURI for a tron option but still returns the destination", async () => {
    const baseUrl = await start();
    const res = await callback(baseUrl, "amount=20000000&paymentOption=ff-usdttrc");
    expect(res.body.paymentDestination).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
    expect(res.body).not.toHaveProperty("paymentURI");
    expect(res.body.paymentQuote.payment.unit).toBe("USDT");
  });

  it("the lightning, arkade and onchain callback answers are unchanged", async () => {
    const shape = (body: Record<string, any>, baseUrl: string) => {
      const rebased = JSON.parse(JSON.stringify(body).split(baseUrl).join("BASE"));
      return { ...rebased, pr: typeof body.pr, verify: typeof body.verify, expiresAt: typeof body.expiresAt };
    };
    const without = await start({}, false);
    const withFf = await start();
    for (const query of ["amount=5000000", "amount=5000000&paymentOption=lightning", "amount=5000000&paymentOption=arkade", "amount=20000000&paymentOption=onchain"]) {
      const a = await callback(without, query);
      const b = await callback(withFf, query);
      expect(shape(b.body, withFf), query).toEqual(shape(a.body, without));
    }
  });
});
