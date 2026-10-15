import { describe, expect, it } from "vitest";
import type { RouterContext } from "@arkade-os/sdk";
import { createLnurlClient, formatUnitAmount, parseUnitAmount } from "../src/index.js";
import { LNURL_ARKADE_RAIL, LNURL_LIGHTNING_RAIL, lnurlQuoteMeta, lnurlRails } from "../src/rail.js";
import { buildInvoice, HASH } from "./invoice.js";

describe("unit amounts", () => {
  it("formats an amount in the unit's smallest denomination", () => {
    expect(formatUnitAmount("500", 2)).toBe("5.00");
    expect(formatUnitAmount(7, 2)).toBe("0.07");
    expect(formatUnitAmount("1234567", 6)).toBe("1.234567");
    expect(formatUnitAmount("42", 0)).toBe("42");
  });

  it("parses a typed decimal, refusing more places than the unit has", () => {
    expect(parseUnitAmount("5", 2)).toBe(500);
    expect(parseUnitAmount("5.5", 2)).toBe(550);
    expect(parseUnitAmount(" .07 ", 2)).toBe(7);
    expect(parseUnitAmount("12", 0)).toBe(12);
    for (const bad of ["", ".", "5.123", "-1", "0", "1e3", "abc", "1.2.3", "0.00"]) expect(parseUnitAmount(bad, 2), bad).toBeUndefined();
  });
});

const ctx = { wallet: {}, prefs: {} } as unknown as RouterContext;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const quote = { requested: { amount: "500", unit: "USD" }, payment: { amount: "1000000", unit: "msat" } };

function railsFor(answer: (url: URL) => unknown) {
  const seen: { raw: string; amount?: number }[] = [];
  const urls: URL[] = [];
  const inner = (id: string) => ({
    id,
    match: () => true,
    quote: async (req: { raw: string; amount?: number }) => {
      seen.push({ raw: req.raw, amount: req.amount });
      return { railId: id, amount: 1000, fee: 0, total: 1000, send: async () => ({}) } as never;
    },
  });
  const fetchImpl = async (input: string) => {
    const url = new URL(input);
    if (!url.pathname.endsWith("/callback")) {
      return json({
        tag: "payRequest", callback: "https://arkadeos.com/.well-known/lnurlp/alice/callback", minSendable: 1000, maxSendable: 100_000_000, metadata: "[]",
        paymentOptions: [{ id: "lightning", type: "lightning" }, { id: "arkade", type: "arkade" }], units: [{ code: "USD", decimals: 2 }],
      });
    }
    urls.push(url);
    return json(answer(url));
  };
  const rails = lnurlRails({ client: createLnurlClient({ fetchImpl: fetchImpl as never }), arkade: inner("ark"), lightning: inner("solver-lightning") });
  return { by: (id: string) => rails.find((r) => r.id === id)!, seen, urls };
}

describe("lnurl rails in a unit", () => {
  const req = { raw: "alice@arkadeos.com", unitAmount: { unit: "usd", amount: 500 } };

  it("pays the arkade destination the quoted sats and records what was asked", async () => {
    const { by, seen, urls } = railsFor(() => ({ status: "OK", paymentOption: "arkade", paymentDestination: "tark1dest", paymentQuote: quote }));
    expect(await by(LNURL_ARKADE_RAIL).available!(req, ctx)).toBe(true);
    const q = await by(LNURL_ARKADE_RAIL).quote(req, ctx);
    expect(urls[0]!.search).toBe("?amount=500&paymentOption=arkade&unit=USD");
    expect(seen).toEqual([{ raw: "tark1dest", amount: 1000 }]);
    expect(lnurlQuoteMeta(q)?.quote).toEqual({ amount: "500", unit: "USD", decimals: 2 });
  });

  it("hands the lightning leg the quoted invoice", async () => {
    const pr = buildInvoice(HASH, 1000);
    const { by, seen } = railsFor(() => ({ pr, routes: [], paymentQuote: quote }));
    const q = await by(LNURL_LIGHTNING_RAIL).quote(req, ctx);
    expect(seen).toEqual([{ raw: pr, amount: undefined }]);
    expect(lnurlQuoteMeta(q)?.quote).toEqual({ amount: "500", unit: "USD", decimals: 2 });
  });

  it("is unavailable for a unit the target does not quote", async () => {
    const { by } = railsFor(() => ({}));
    const eur = { raw: "alice@arkadeos.com", unitAmount: { unit: "EUR", amount: 500 } };
    expect(await by(LNURL_ARKADE_RAIL).available!(eur, ctx)).toBe(false);
  });

  it("refuses a destination quote for a different amount", async () => {
    const { by, seen } = railsFor(() => ({ status: "OK", paymentOption: "arkade", paymentDestination: "tark1dest", paymentQuote: { ...quote, requested: { amount: "50000", unit: "USD" } } }));
    await expect(by(LNURL_ARKADE_RAIL).quote(req, ctx)).rejects.toThrow("did not quote 500 USD");
    expect(seen).toEqual([]);
  });
});
