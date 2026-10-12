import { describe, it, expect, afterEach } from "vitest";
import { fakeFixedFloat, type FakeFf } from "./helpers/fake-fixedfloat.js";
import { FfBudget, ffAuth, ffClient, ffHttpTransport } from "../src/rails/fixedfloat/client.js";
import { FF_ASSETS } from "../src/rails/fixedfloat/catalogue.js";
import { ffRates, ffRatesXml, parseRatesXml } from "../src/rails/fixedfloat/rates.js";

let ff: FakeFf | undefined;
afterEach(async () => { await ff?.close(); ff = undefined; });

const ratesFor = (f: FakeFf, opts: { allow?: string[]; deny?: string[]; now?: () => number; staleAfterMs?: number; budget?: FfBudget } = {}) =>
  ffRates({
    client: ffClient({ transport: ffHttpTransport({ baseUrl: f.baseUrl, auth: ffAuth(f.apiKey, f.secret) }), budget: opts.budget ?? new FfBudget() }),
    fetchRatesXml: ffRatesXml(f.ratesUrl),
    idPrefix: "ff-",
    staleAfterMs: opts.staleAfterMs ?? 900_000,
    ...(opts.allow ? { allow: opts.allow } : {}),
    ...(opts.deny ? { deny: opts.deny } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });

const codes = (r: ReturnType<typeof ratesFor>) => r.snapshot().rails.map((x) => x.ffCode);

describe("FixedFloat rates", () => {
  it("parses minamount with its trailing currency code", () => {
    const rows = parseRatesXml(
      "<rates><item><from>USDCARBITRUM</from><to>BTCLN</to><in>1</in><out>0.000011873265</out>" +
      "<minamount>2.4115271059 USDCARBITRUM</minamount><maxamount>15007.7730000000 USDCARBITRUM</maxamount></item></rates>",
    );
    expect(rows).toEqual([{ from: "USDCARBITRUM", to: "BTCLN", out: 0.000011873265, min: 2.4115271059, max: 15007.773 }]);
  });

  it("converts from-currency bounds to sats, rounding the minimum up and the maximum down", async () => {
    ff = await fakeFixedFloat();
    const rates = ratesFor(ff);
    await rates.refresh();
    const rail = rates.snapshot().rails.find((r) => r.ffCode === "USDTARBITRUM");
    // 2.3959966639 x 0.000011868696 BTC = 2843.7 sat; 15013.55 x 0.000011868696 BTC = 17819126.08 sat.
    expect(rail).toEqual({
      optionId: "ff-usdtarbitrum", ffCode: "USDTARBITRUM", unit: "USDT", decimals: 6, minSat: 2844, maxSat: 17_819_126,
      asset: "eip155:42161/erc20:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9",
    });
    expect(rates.snapshot().ready).toBe(true);
  });

  it("drops a currency whose ccies entry says send=0", async () => {
    ff = await fakeFixedFloat();
    // The shape USDTOP and USDTTON had in the 2026-10-07 capture.
    ff.ccies = ff.ccies.map((c) => (c.code === "USDCOP" ? { ...c, send: 0, recv: 0 } : c));
    const rates = ratesFor(ff);
    await rates.refresh();
    expect(codes(rates)).not.toContain("USDCOP");
    expect(codes(rates)).toContain("USDCBASE");
  });

  it("drops a currency FixedFloat will not take in, even while it still sends it", async () => {
    ff = await fakeFixedFloat();
    ff.ccies = ff.ccies.map((c) => (c.code === "USDCOP" ? { ...c, send: 1, recv: 0 } : c));
    const rates = ratesFor(ff);
    await rates.refresh();
    expect(codes(rates)).not.toContain("USDCOP");
  });

  it("drops a currency with no from -> BTCLN row", async () => {
    ff = await fakeFixedFloat();
    ff.rates = ff.rates.filter((r) => r.from !== "USDCBASE");
    const rates = ratesFor(ff);
    await rates.refresh();
    expect(codes(rates)).not.toContain("USDCBASE");
    expect(codes(rates)).toContain("USDCOP");
  });

  it("applies FIXEDFLOAT_DENY after FIXEDFLOAT_ALLOW", async () => {
    ff = await fakeFixedFloat();
    const rates = ratesFor(ff, { allow: ["USDTARBITRUM", "USDTSOL"], deny: ["USDTSOL"] });
    await rates.refresh();
    expect(codes(rates)).toEqual(["USDTARBITRUM"]);
  });

  it("reports not-ready with a reason when the last refresh failed, keeping the previous snapshot", async () => {
    ff = await fakeFixedFloat();
    const rates = ratesFor(ff);
    await rates.refresh();
    const before = rates.snapshot().rails;
    ff.ratesStatus = 503;
    await rates.refresh();
    expect(rates.snapshot()).toMatchObject({ ready: false, rails: before });
    expect(rates.snapshot().reason).toMatch(/503/);
  });

  it("keeps the last snapshot when its own budget refuses the refresh, which says nothing about FixedFloat", async () => {
    ff = await fakeFixedFloat();
    const budget = new FfBudget();
    const rates = ratesFor(ff, { budget });
    await rates.refresh();
    while (budget.take(1));
    await rates.refresh();
    expect(rates.snapshot().ready).toBe(true);
  });

  it("is not ready while FixedFloat cannot send Lightning at all", async () => {
    ff = await fakeFixedFloat();
    ff.ccies = ff.ccies.map((c) => (c.code === "BTCLN" ? { ...c, send: 0 } : c));
    const rates = ratesFor(ff);
    await rates.refresh();
    expect(rates.snapshot()).toMatchObject({ ready: false, rails: [] });
    expect(rates.snapshot().reason).toMatch(/BTCLN/);
  });

  it("goes stale when no refresh succeeds within the window", async () => {
    let now = 0;
    ff = await fakeFixedFloat();
    const rates = ratesFor(ff, { now: () => now, staleAfterMs: 900_000 });
    expect(rates.snapshot()).toMatchObject({ ready: false, rails: [] });
    await rates.refresh();
    now = 899_999;
    expect(rates.snapshot().ready).toBe(true);
    now = 900_000;
    expect(rates.snapshot()).toMatchObject({ ready: false });
    expect(rates.snapshot().rails.length).toBeGreaterThan(0);
    expect(rates.snapshot().reason).toMatch(/stale/);
  });

  it("never advertises a code absent from FF_ASSETS", async () => {
    ff = await fakeFixedFloat();
    const rates = ratesFor(ff);
    await rates.refresh();
    // The fake offers USDTBSC with send=1 and a BTCLN row; it has 18 decimals and no table entry.
    expect(ff.ccies.some((c) => c.code === "USDTBSC")).toBe(true);
    expect(codes(rates)).not.toContain("USDTBSC");
    expect(codes(rates).sort()).toEqual(Object.keys(FF_ASSETS).sort());
  });
});
