import { describe, expect, it } from "vitest";
import type { PaymentRail, RouteQuote, RouterContext } from "@arkade-os/sdk";
import { createLnurlClient } from "../src/index.js";
import { LNURL_ARKADE_RAIL, LNURL_LIGHTNING_RAIL, lnurlRails } from "../src/rail.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const payRequest = (over: Record<string, unknown> = {}) => ({
  tag: "payRequest",
  callback: "https://arkadeos.com/.well-known/lnurlp/alice/callback",
  minSendable: 1000,
  maxSendable: 100_000_000,
  metadata: '[["text/plain","pay alice"]]',
  paymentOptions: [
    { id: "lightning", type: "lightning" },
    { id: "arkade", type: "arkade" },
  ],
  ...over,
});

const ctx = { wallet: {}, prefs: {} } as unknown as RouterContext;

/** Stands in for arkRail/solverLightningRail: records what it was asked to pay. */
function fakeRail(id: string): PaymentRail & { seen: { raw: string; amount?: number }[] } {
  const seen: { raw: string; amount?: number }[] = [];
  return {
    id,
    seen,
    match: () => true,
    quote: async (req) => {
      seen.push({ raw: req.raw, amount: req.amount });
      return { railId: id, amount: 500, fee: 7, total: 507, send: async () => ({}) } as unknown as RouteQuote;
    },
  };
}

function railsFor(fetchImpl: (url: string, init?: unknown) => Promise<Response>, lightning = true) {
  const arkade = fakeRail("ark");
  const inner = fakeRail("solver-lightning");
  const rails = lnurlRails({
    client: createLnurlClient({ fetchImpl: fetchImpl as never }),
    arkade,
    ...(lightning ? { lightning: inner } : {}),
  });
  return { rails, arkade, inner, by: (id: string) => rails.find((r) => r.id === id)! };
}

describe("lnurl rails", () => {
  it("matches an lnurl target without touching the network", () => {
    let calls = 0;
    const { by } = railsFor(async () => { calls++; return json(payRequest()); });

    expect(by(LNURL_ARKADE_RAIL).match({ raw: "alice@arkadeos.com" }, ctx)).toBe(true);
    expect(by(LNURL_ARKADE_RAIL).match({ raw: "tark1qsomething" }, ctx)).toBe(false);
    expect(calls).toBe(0);
  });

  it("classifies on shape alone, leaving a bad checksum to the resolve", () => {
    // Deliberately looser than isValidLnUrl: the SDK's contract is that match()
    // is format-only and the rail re-validates before spending. A strict match
    // would answer "no rail for this target" to what is really a bad LNURL.
    const { by } = railsFor(async () => json(payRequest()));
    expect(by(LNURL_ARKADE_RAIL).match({ raw: "LNURL1BOGUSCHECKSUM" }, ctx)).toBe(true);
  });

  it("resolves the payRequest once across both rails", async () => {
    let calls = 0;
    const { rails } = railsFor(async () => { calls++; return json(payRequest()); });
    const req = { raw: "alice@arkadeos.com", amount: 500 };

    for (const rail of rails) await rail.available!(req, ctx);

    expect(calls).toBe(1);
  });

  it("drops a rail the address does not advertise", async () => {
    const { by } = railsFor(async () => json(payRequest({ paymentOptions: [{ id: "lightning", type: "lightning" }] })));
    const req = { raw: "alice@arkadeos.com", amount: 500 };

    expect(await by(LNURL_ARKADE_RAIL).available!(req, ctx)).toBe(false);
    expect(await by(LNURL_LIGHTNING_RAIL).available!(req, ctx)).toBe(true);
  });

  it("gates on the option's own bounds, not the envelope", async () => {
    const { by } = railsFor(async () => json(payRequest({
      paymentOptions: [
        { id: "lightning", type: "lightning" },
        { id: "arkade", type: "arkade", minSendable: 10_000, maxSendable: 20_000 },
      ],
    })));

    expect(await by(LNURL_ARKADE_RAIL).available!({ raw: "alice@arkadeos.com", amount: 5 }, ctx)).toBe(false);
    expect(await by(LNURL_ARKADE_RAIL).available!({ raw: "alice@arkadeos.com", amount: 15 }, ctx)).toBe(true);
  });

  it("pays the destination the callback returns, through the arkade rail", async () => {
    const { by, arkade } = railsFor(async (url) =>
      String(url).includes("callback")
        ? json({ paymentOption: "arkade", paymentDestination: "tark1qdest" })
        : json(payRequest()));

    const quote = await by(LNURL_ARKADE_RAIL).quote({ raw: "alice@arkadeos.com", amount: 500 }, ctx);

    expect(arkade.seen).toEqual([{ raw: "tark1qdest", amount: 500 }]);
    expect(quote.railId).toBe(LNURL_ARKADE_RAIL);
    expect(quote.total).toBe(507);
  });

  it("hands the invoice to the lightning rail without restating the amount", async () => {
    const { by, inner } = railsFor(async (url) =>
      String(url).includes("callback")
        ? json({ pr: "lnbc5u1pexample" })
        : json(payRequest()));

    await by(LNURL_LIGHTNING_RAIL).quote({ raw: "alice@arkadeos.com", amount: 500 }, ctx);

    // The invoice fixes the amount; solverLightningRail refuses a req.amount
    // that disagrees, so the rail must not restate it.
    expect(inner.seen).toEqual([{ raw: "lnbc5u1pexample", amount: undefined }]);
  });

  it("keeps the arkade rail off a session payRequest, which has no rails", async () => {
    const { by } = railsFor(async () => json({
      tag: "payRequest",
      callback: "https://arkadeos.com/lnurl/abc/callback",
      minSendable: 1000,
      maxSendable: 100_000_000,
      metadata: '[["text/plain","session"]]',
    }));
    const req = { raw: "LNURL1DP68GURN8GHJ7MRWW4EXCTNDW46XJMNEDEJHGTNPWF4KZER99EEKSTEWWAJKCMPDDDHX7AMW9AKXUATJD3CZ7URJDA3X2MT4XEM8G7RW0GTE4X83", amount: 500 };

    expect(await by(LNURL_ARKADE_RAIL).available!(req, ctx)).toBe(false);
  });

  it("registers no lightning rail when none was supplied", () => {
    const { rails } = railsFor(async () => json(payRequest()), false);
    expect(rails.map((r) => r.id)).toEqual([LNURL_ARKADE_RAIL]);
  });
});
