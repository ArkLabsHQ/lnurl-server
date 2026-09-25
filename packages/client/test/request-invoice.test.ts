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
