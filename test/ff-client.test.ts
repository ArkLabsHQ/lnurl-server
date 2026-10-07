import { describe, it, expect, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { fakeFixedFloat, fail, type FakeFf } from "./helpers/fake-fixedfloat.js";
import { FfApiError, FfBudget, FfBudgetError, ffAuth, ffClient, ffHttpTransport } from "../src/rails/fixedfloat/client.js";

let ff: FakeFf | undefined;
afterEach(async () => { await ff?.close(); ff = undefined; });

const clientFor = (f: FakeFf, opts: { secret?: string; budget?: FfBudget; now?: () => number } = {}) =>
  ffClient({
    transport: ffHttpTransport({ baseUrl: f.baseUrl, auth: ffAuth(f.apiKey, opts.secret ?? f.secret) }),
    budget: opts.budget ?? new FfBudget(),
    ...(opts.now ? { now: opts.now } : {}),
  });

const BOLT11 = "lnbc100u1fakeinvoice";

describe("FixedFloat client", () => {
  it("signs each call with hex HMAC-SHA256 over the raw body", async () => {
    const auth = ffAuth("key", "secret");
    expect(auth.headers('{"a":1}')).toEqual({
      "X-API-KEY": "key",
      "X-API-SIGN": createHmac("sha256", "secret").update('{"a":1}').digest("hex"),
    });
    ff = await fakeFixedFloat();
    await clientFor(ff).price({ fromCcy: "USDTARBITRUM", toSat: 10_000 });
    expect(ff.calls).toEqual([{ method: "price", weight: 1, body: { type: "fixed", fromCcy: "USDTARBITRUM", toCcy: "BTCLN", direction: "to", amount: 0.0001 } }]);
  });

  it("throws FfApiError carrying code and msg on a non-zero code", async () => {
    ff = await fakeFixedFloat();
    ff.create = () => fail(304, "Invalid route, unable to find a path to destination");
    const client = clientFor(ff);
    const error = await client.create({ fromCcy: "USDTARBITRUM", toSat: 10_000, toAddress: BOLT11 }, client.reserveCreate()!).catch((e) => e);
    expect(error).toBeInstanceOf(FfApiError);
    expect(error).toMatchObject({ method: "create", code: 304 });
    expect(error.message).toContain("Invalid route");
  });

  it("an error message contains neither the api key nor the secret", async () => {
    ff = await fakeFixedFloat({ apiKey: "KEY-0123456789", secret: "SECRET-9876543210" });
    const wrongSecret = await clientFor(ff, { secret: "SECRET-wrong" }).ccies().catch((e: Error) => e);
    ff.price = () => fail(500, `rejected KEY-0123456789 signed with SECRET-9876543210`);
    const echoed = await clientFor(ff).price({ fromCcy: "USDTARBITRUM", toSat: 10_000 }).catch((e: Error) => e);
    for (const error of [wrongSecret, echoed]) {
      expect(error).toBeInstanceOf(FfApiError);
      const text = `${(error as Error).message} ${JSON.stringify(error)} ${String((error as Error).stack)}`;
      expect(text).not.toContain("KEY-0123456789");
      expect(text).not.toContain("SECRET-9876543210");
      expect(text).not.toContain("SECRET-wrong");
    }
  });

  it("spends 50 budget units on create and 1 on every other method", async () => {
    ff = await fakeFixedFloat();
    const budget = new FfBudget();
    const client = clientFor(ff, { budget });
    await client.ccies();
    expect(budget.used()).toBe(1);
    await client.price({ fromCcy: "USDTARBITRUM", toSat: 10_000 });
    expect(budget.used()).toBe(2);
    const reservation = client.reserveCreate()!;
    expect(budget.used()).toBe(52);
    const order = await client.create({ fromCcy: "USDTARBITRUM", toSat: 10_000, toAddress: BOLT11 }, reservation);
    expect(budget.used()).toBe(52);
    await client.order(order.id, order.token);
    expect(budget.used()).toBe(53);
    expect(ff.calls.map((c) => [c.method, c.weight])).toEqual([["ccies", 1], ["price", 1], ["create", 50], ["order", 1]]);
  });

  it("hands back a create reservation that was never used", async () => {
    const budget = new FfBudget();
    ff = await fakeFixedFloat();
    const reservation = clientFor(ff, { budget }).reserveCreate()!;
    expect(budget.used()).toBe(50);
    reservation.release();
    reservation.release();
    expect(budget.used()).toBe(0);
  });

  it("refuses with FfBudgetError rather than queueing once 250 units are spent in a minute", async () => {
    ff = await fakeFixedFloat();
    const budget = new FfBudget(250, 60_000, () => 1_000);
    const client = clientFor(ff, { budget });
    for (let i = 0; i < 5; i++) expect(client.reserveCreate()).toBeDefined();
    expect(client.reserveCreate()).toBeUndefined();
    const started = Date.now();
    await expect(client.ccies()).rejects.toBeInstanceOf(FfBudgetError);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(ff.calls).toEqual([]);
  });

  it("releases budget as the minute window rolls", async () => {
    let now = 0;
    const budget = new FfBudget(250, 60_000, () => now);
    for (let i = 0; i < 5; i++) budget.take(50);
    now = 59_999;
    expect(budget.take(1)).toBeUndefined();
    now = 60_000;
    expect(budget.take(50)).toBeDefined();
    expect(budget.used()).toBe(50);
  });

  it("reads ccies send/recv flags whether ff.io sends them as numbers or booleans", async () => {
    ff = await fakeFixedFloat();
    ff.ccies = [
      { code: "USDTARBITRUM", coin: "USDT", network: "ARBITRUM", recv: 1, send: 1, tag: null, contract: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9" },
      { code: "USDTOP", coin: "USDT", network: "OP", recv: 0, send: false, tag: null, contract: "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58" },
      { code: 7, coin: "broken" },
    ];
    expect(await clientFor(ff).ccies()).toEqual([
      { code: "USDTARBITRUM", coin: "USDT", network: "ARBITRUM", recv: true, send: true, tag: null, contract: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9" },
      { code: "USDTOP", coin: "USDT", network: "OP", recv: false, send: false, tag: null, contract: "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58" },
    ]);
  });

  it("takes the order deadline as the earlier of time.expiration and now + time.left", async () => {
    ff = await fakeFixedFloat();
    const client = clientFor(ff, { now: () => 1_000_000_000 });
    const order = await client.create({ fromCcy: "USDTARBITRUM", toSat: 10_000, toAddress: BOLT11 }, client.reserveCreate()!);
    const stored = ff.orders.get(order.id)!;
    stored.time = { ...stored.time, expiration: 1_000_000 + 1_800, left: 600 };
    expect((await client.order(order.id, order.token)).expiresAt).toBe(1_000_000 + 600);
    stored.time = { ...stored.time, expiration: 1_000_000 + 300, left: 600 };
    expect((await client.order(order.id, order.token)).expiresAt).toBe(1_000_000 + 300);
  });

  it("parses the created order's deposit leg and keeps amounts as decimal strings", async () => {
    ff = await fakeFixedFloat();
    const client = clientFor(ff);
    const order = await client.create({ fromCcy: "USDTARBITRUM", toSat: 10_000, toAddress: BOLT11 }, client.reserveCreate()!);
    expect(order).toMatchObject({ type: "fixed", status: "NEW", from: { code: "USDTARBITRUM", amount: "8.426", tag: null, txid: null }, to: { code: "BTCLN", amount: "0.00010000" } });
    expect(order.from.address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(ff.calls.at(-1)?.body).toEqual({ type: "fixed", fromCcy: "USDTARBITRUM", toCcy: "BTCLN", direction: "to", amount: 0.0001, toAddress: BOLT11 });
  });
});
