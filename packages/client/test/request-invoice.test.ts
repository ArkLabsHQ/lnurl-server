import { describe, it, expect } from "vitest";
import { requestInvoice } from "../src/payer.js";
import type { PayRequest } from "../src/types.js";
import { LnurlError } from "../src/errors.js";
import { buildInvoice, HASH } from "./invoice.js";

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const addressPr: PayRequest = {
  tag: "payRequest",
  callback: "https://arkadeos.com/.well-known/lnurlp/alice/callback",
  minSendable: 1000,
  maxSendable: 100000000,
  metadata: "[]",
  source: { url: "https://arkadeos.com/.well-known/lnurlp/alice", surface: "address" },
};
const sessionPr: PayRequest = { ...addressPr, source: { url: "https://x/lnurl/abc", surface: "session" } };

describe("requestInvoice", () => {
  it("converts sats to msats on the query", async () => {
    let seen = "";
    const invoice = buildInvoice(HASH, 2100);
    const fetchImpl = async (url: string) => { seen = String(url); return jsonResponse({ pr: invoice, routes: [], verify: "https://x/v/h" }); };
    const r = await requestInvoice(addressPr, { amountSat: 2100 }, fetchImpl as never);
    expect(seen).toContain("amount=2100000");
    expect(r).toMatchObject({ kind: "bolt11", pr: invoice, verify: "https://x/v/h" });
  });

  it("range-checks before hitting the network", async () => {
    const fetchImpl = async () => { throw new Error("must not be called"); };
    await expect(requestInvoice(addressPr, { amountSat: 0 }, fetchImpl as never)).rejects.toBeInstanceOf(LnurlError);
    await expect(requestInvoice(addressPr, { amountSat: 999999999 }, fetchImpl as never)).rejects.toBeInstanceOf(LnurlError);
  });

  it("refuses a fraction of a millisat before hitting the network", async () => {
    const fetchImpl = async () => { throw new Error("must not be called"); };
    await expect(requestInvoice(addressPr, { amountSat: 1.0001 }, fetchImpl as never)).rejects.toThrow(
      "Amount must be a whole number of millisats",
    );
  });

  it("omits an empty comment rather than sending one a payRequest forbids", async () => {
    let seen = "";
    const fetchImpl = async (url: string) => {
      seen = String(url);
      return jsonResponse({ pr: buildInvoice(HASH, 1000), routes: [] });
    };
    // commentAllowed is absent, so comments are not supported at all.
    await requestInvoice(addressPr, { amountSat: 1000, comment: "" }, fetchImpl as never);
    expect(seen).not.toContain("comment");
  });

  it("range-checks a selected option against its own bounds, not the top-level pair", async () => {
    const narrowed: PayRequest = {
      ...addressPr,
      paymentOptions: [
        { id: "lightning", type: "lightning" },
        { id: "arkade", type: "arkade", minSendable: 10_000, maxSendable: 5_000_000 },
      ],
    };
    const reject = async () => { throw new Error("must not be called"); };
    // Inside the top-level pair but outside the arkade rail's, so caught locally.
    await expect(requestInvoice(narrowed, { amountSat: 50_000, paymentOption: "arkade" }, reject as never)).rejects.toThrow(
      "Amount must be between 10000 and 5000000 millisats",
    );
    await expect(requestInvoice(narrowed, { amountSat: 5, paymentOption: "arkade" }, reject as never)).rejects.toBeInstanceOf(LnurlError);

    // The same amount on the unnarrowed lightning option still reaches the wire.
    const fetchImpl = async () => jsonResponse({ pr: buildInvoice(HASH, 50_000), routes: [] });
    await expect(
      requestInvoice(narrowed, { amountSat: 50_000, paymentOption: "lightning" }, fetchImpl as never),
    ).resolves.toMatchObject({ kind: "bolt11" });
  });

  it("returns a destination result for a non-pr option", async () => {
    const fetchImpl = async () => jsonResponse({ status: "OK", paymentOption: "arkade", paymentDestination: "ark1xyz", verify: "https://x/v/id" });
    const r = await requestInvoice(addressPr, { amountSat: 1000, paymentOption: "arkade" }, fetchImpl as never);
    expect(r).toEqual({ kind: "destination", paymentOption: "arkade", paymentDestination: "ark1xyz", verify: "https://x/v/id" });
  });

  it("tolerates a callback response with no verify URL", async () => {
    const fetchImpl = async () => jsonResponse({ pr: buildInvoice(HASH, 1000), routes: [] });
    const r = await requestInvoice(addressPr, { amountSat: 1000 }, fetchImpl as never);
    expect(r).toMatchObject({ kind: "bolt11", verify: undefined });
  });

  it("refuses paymentOption on a session payRequest", async () => {
    const fetchImpl = async () => { throw new Error("must not be called"); };
    await expect(requestInvoice(sessionPr, { amountSat: 1000, paymentOption: "arkade" }, fetchImpl as never))
      .rejects.toThrow(/session/i);
  });

  it("takes paymentOption on a session payRequest that advertises options, as a nameless receiver's does", async () => {
    const nameless: PayRequest = { ...sessionPr, paymentOptions: [{ id: "lightning", type: "lightning" }, { id: "arkade", type: "arkade" }] };
    let seen = "";
    const fetchImpl = async (url: string) => { seen = String(url); return jsonResponse({ status: "OK", paymentOption: "arkade", paymentDestination: "ark1xyz" }); };
    await expect(requestInvoice(nameless, { amountSat: 1000, paymentOption: "arkade" }, fetchImpl as never))
      .resolves.toMatchObject({ kind: "destination", paymentDestination: "ark1xyz" });
    expect(seen).toContain("paymentOption=arkade");
  });

  it("passes comment through when allowed", async () => {
    let seen = "";
    const fetchImpl = async (url: string) => { seen = String(url); return jsonResponse({ pr: buildInvoice(HASH, 1000), routes: [] }); };
    await requestInvoice({ ...addressPr, commentAllowed: 140 }, { amountSat: 1000, comment: "hi there" }, fetchImpl as never);
    expect(seen).toContain("comment=hi+there");
  });

  // Checked locally for the same reason the amount is: the server rejects it
  // anyway, but a round trip later and with a vaguer message.
  it("refuses a comment longer than commentAllowed before hitting the network", async () => {
    const fetchImpl = async () => { throw new Error("must not be called"); };
    await expect(
      requestInvoice({ ...addressPr, commentAllowed: 10 }, { amountSat: 1000, comment: "x".repeat(11) }, fetchImpl as never),
    ).rejects.toThrow(/at most 10 characters/);
  });

  // LUD-12: an absent or zero commentAllowed means comments are not supported.
  it("refuses a comment when the payRequest advertises none", async () => {
    const fetchImpl = async () => { throw new Error("must not be called"); };
    await expect(
      requestInvoice(addressPr, { amountSat: 1000, comment: "hi" }, fetchImpl as never),
    ).rejects.toThrow(/does not accept comments/);
  });

  it("accepts a bolt11 whose amount matches the request", async () => {
    const fetchImpl = async () => jsonResponse({ pr: buildInvoice(HASH, 1000), routes: [] });
    await expect(requestInvoice(addressPr, { amountSat: 1000 }, fetchImpl as never)).resolves.toMatchObject({ kind: "bolt11" });
  });

  it("refuses a bolt11 whose amount disagrees with the request", async () => {
    const fetchImpl = async () => jsonResponse({ pr: buildInvoice(HASH, 999), routes: [] });
    await expect(requestInvoice(addressPr, { amountSat: 1000 }, fetchImpl as never)).rejects.toBeInstanceOf(LnurlError);
  });

  it("refuses a bolt11 that does not decode", async () => {
    const fetchImpl = async () => jsonResponse({ pr: "lnbc1notbech32", routes: [] });
    await expect(requestInvoice(addressPr, { amountSat: 1000 }, fetchImpl as never)).rejects.toBeInstanceOf(LnurlError);
  });

  // An amountless invoice could settle for any amount, so it cannot stand in
  // for the fixed amount an amounted request asked for.
  it("refuses an amountless bolt11 answering an amounted request", async () => {
    const fetchImpl = async () => jsonResponse({ pr: buildInvoice(HASH), routes: [] });
    await expect(requestInvoice(addressPr, { amountSat: 1000 }, fetchImpl as never)).rejects.toBeInstanceOf(LnurlError);
  });
});

describe("requestInvoice in a unit", () => {
  const usd: PayRequest = { ...sessionPr, units: [{ code: "USD", decimals: 2, minAmount: "50", maxAmount: "100000" }] };
  // $1.00 at $50,000/BTC.
  const quote = { requested: { amount: "100", unit: "USD" }, payment: { amount: "2000000", unit: "msat" } };
  const callback = (body: Record<string, unknown>, seen: string[] = []) => async (url: string) => { seen.push(String(url)); return jsonResponse(body); };
  const offline = async () => { throw new Error("must not be called"); };

  it("sends the amount in the unit's smallest denomination and pays the quoted millisats", async () => {
    const seen: string[] = [];
    const pr = buildInvoice(HASH, 2000);
    const r = await requestInvoice(usd, { unit: "usd", amount: 100 }, callback({ pr, routes: [], paymentQuote: quote }, seen) as never);
    expect(seen[0]).toContain("amount=100&unit=USD");
    expect(r).toMatchObject({ kind: "bolt11", pr, paymentQuote: quote });
  });

  it("refuses an invoice that is not for the quoted millisats", async () => {
    await expect(requestInvoice(usd, { unit: "USD", amount: 100 }, callback({ pr: buildInvoice(HASH, 1999), routes: [], paymentQuote: quote }) as never))
      .rejects.toThrow("not the quoted 2000000");
  });

  it("refuses a quote for another amount or unit, or one without millisats", async () => {
    const pr = buildInvoice(HASH, 2000);
    const ask = (paymentQuote: unknown) => requestInvoice(usd, { unit: "USD", amount: 100 }, callback({ pr, routes: [], paymentQuote }) as never);
    await expect(ask({ ...quote, requested: { amount: "1000", unit: "USD" } })).rejects.toThrow("did not quote 100 USD");
    await expect(ask({ ...quote, requested: { amount: "100", unit: "EUR" } })).rejects.toThrow("did not quote 100 USD");
    await expect(ask({ ...quote, payment: { amount: "2000", unit: "sat" } })).rejects.toThrow("no millisat amount");
    await expect(ask(undefined)).rejects.toThrow("did not quote 100 USD");
  });

  it("refuses a unit not offered, or an amount the unit cannot take, before hitting the network", async () => {
    await expect(requestInvoice(sessionPr, { unit: "USD", amount: 100 }, offline as never)).rejects.toThrow("does not quote in USD");
    await expect(requestInvoice(usd, { unit: "USD", amount: 1.5 }, offline as never)).rejects.toThrow(/positive whole number/);
    await expect(requestInvoice(usd, { unit: "USD", amount: 10 }, offline as never)).rejects.toThrow("between 50 and 100000");
    await expect(requestInvoice(usd, { unit: "USD", amount: 100_001 }, offline as never)).rejects.toThrow("between 50 and 100000");
  });
});

describe("requestInvoice on a token option", () => {
  const DEPOSIT = "0x" + "ab".repeat(20);
  const tokenPr: PayRequest = {
    ...addressPr,
    units: [{ code: "USDT", decimals: 6, name: "Tether USD" }],
    paymentOptions: [
      { id: "lightning", type: "lightning" },
      { id: "ff-usdtarbitrum", type: "eip155", asset: "eip155:42161/erc20:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", unit: "USDT", provider: "FixedFloat", verifiable: true, minSendable: 2_844_000, maxSendable: 100_000_000 },
    ],
  };
  const quote = { id: "AB12CD", expiresAt: "2026-10-08T00:00:00.000Z", requested: { amount: "10000000", unit: "msat" }, payment: { amount: "8426000", unit: "USDT" } };
  const answer = {
    status: "OK", paymentOption: "ff-usdtarbitrum", paymentDestination: DEPOSIT, provider: "FixedFloat", paymentQuote: quote,
    paymentURI: `ethereum:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9@42161/transfer?address=${DEPOSIT}&uint256=8426000`,
    verify: "https://x/lnurl/verify/" + HASH, verifyBatch: "https://x/lnurl/verifyBatch",
  };
  const ask = (body: unknown) => requestInvoice(tokenPr, { amountSat: 10_000, paymentOption: "ff-usdtarbitrum" }, (async () => jsonResponse(body)) as never);

  it("carries paymentQuote, paymentURI, provider and expiresAt through a destination result", async () => {
    expect(await ask(answer)).toEqual({
      kind: "destination", paymentOption: "ff-usdtarbitrum", paymentDestination: DEPOSIT, paymentURI: answer.paymentURI, provider: "FixedFloat",
      paymentQuote: quote, verify: answer.verify, verifyBatch: answer.verifyBatch,
    });
    const arkade = await requestInvoice(tokenPr, { amountSat: 10_000, paymentOption: "arkade" },
      (async () => jsonResponse({ status: "OK", paymentOption: "arkade", paymentDestination: "ark1x", expiresAt: 1_900_000_000 })) as never);
    expect(arkade).toMatchObject({ kind: "destination", expiresAt: 1_900_000_000 });
  });

  it("refuses a token answer whose destination is not an address of the option's chain", async () => {
    await expect(ask({ ...answer, paymentDestination: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" })).rejects.toThrow(/eip155/);
    await expect(ask({ ...answer, paymentDestination: undefined })).rejects.toBeInstanceOf(LnurlError);
  });

  it("refuses a token answer without a whole amount in the option's unit", async () => {
    await expect(ask({ ...answer, paymentQuote: { ...quote, payment: { amount: "8.426", unit: "USDT" } } })).rejects.toThrow(/whole amount of USDT/);
    await expect(ask({ ...answer, paymentQuote: { ...quote, payment: { amount: "8426000", unit: "msat" } } })).rejects.toThrow(/whole amount of USDT/);
    await expect(ask({ ...answer, paymentQuote: undefined })).rejects.toThrow(/whole amount of USDT/);
  });

  it("refuses a token answer for another option", async () => {
    await expect(ask({ ...answer, paymentOption: "ff-usdttrc" })).rejects.toThrow(/ff-usdttrc/);
  });
});
