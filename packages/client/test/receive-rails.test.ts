import { afterEach, describe, expect, it, vi } from "vitest";
import { ArkAddress } from "@arkade-os/sdk";
import { createLnurlClient, type LnurlClient } from "../src/index.js";
import type { InvoiceResult, PayRequest, PaymentOption } from "../src/types.js";
import { lnurlPayableRanges, lnurlRailLimits, resolveLnurlRails } from "../src/receive-rails.js";
import { buildInvoice, HASH } from "./invoice.js";

const arkAddress = (operator = 2, recipient = 3, hrp = "tark") =>
  new ArkAddress(new Uint8Array(32).fill(operator), new Uint8Array(32).fill(recipient), hrp).encode();
const own = { arkade: arkAddress(), onchain: "bcrt1qownboarding" };
const invoice = buildInvoice(HASH, 20);
const options: PaymentOption[] = [
  { id: "ln", type: "lightning" },
  { id: "ark", type: "arkade" },
  { id: "btc", type: "onchain" },
];
const payRequest = (paymentOptions?: PaymentOption[]): PayRequest => ({
  tag: "payRequest", callback: "https://lnurl.test/callback", minSendable: 1000, maxSendable: 100_000,
  metadata: "[]", source: { url: "https://lnurl.test/lnurl/alice", surface: "session" },
  ...(paymentOptions === undefined ? {} : { paymentOptions }),
});
const receiver = (request: PayRequest) => ({ payRequest: async () => request });
const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, headers: { "content-type": "application/json" },
});
const resultClient = (result: InvoiceResult): Pick<LnurlClient, "requestInvoice"> => ({
  requestInvoice: async () => result,
});

afterEach(() => vi.unstubAllGlobals());

describe("lnurlRailLimits", () => {
  it("rounds msat bounds inward and applies each available bitcoin option's bounds", () => {
    const request = { ...payRequest([
      { id: "ln", type: "lightning" },
      { id: "ark", type: "arkade", minSendable: 2001, maxSendable: 5999 },
      { id: "btc", type: "onchain", available: false },
      { id: "token", type: "arkade", asset: "arkade:token" },
    ]), minSendable: 1001, maxSendable: 9999 };
    expect(lnurlRailLimits(request)).toEqual([
      { type: "lightning", min: 2, max: 9 }, { type: "arkade", min: 3, max: 5 },
    ]);
  });

  it("offers legacy Lightning only when options are absent", () => {
    expect(lnurlRailLimits(payRequest())).toEqual([{ type: "lightning", min: 1, max: 100 }]);
    expect(lnurlRailLimits(payRequest([]))).toEqual([]);
  });
});

describe("resolveLnurlRails", () => {
  it("resolves all selected options with the actual client in the requested order", async () => {
    const client = createLnurlClient({ fetchImpl: async (url) => {
      const selected = new URL(String(url)).searchParams.get("paymentOption");
      return jsonResponse(selected === "ln" ? { pr: invoice } : {
        paymentOption: selected, paymentDestination: selected === "ark" ? own.arkade : own.onchain,
      });
    } });
    expect(await resolveLnurlRails(receiver(payRequest(options)), 20, ["onchain", "lightning", "arkade"], own, client))
      .toEqual([own.onchain, invoice, own.arkade].map((value) => ({ status: "fulfilled", value })));
  });

  it("uses the default client for a legacy Lightning request without an option selector", async () => {
    let query: URLSearchParams | undefined;
    vi.stubGlobal("fetch", async (url: string) => {
      query = new URL(url).searchParams;
      return jsonResponse({ pr: invoice });
    });
    expect(await resolveLnurlRails(receiver(payRequest()), 20, ["lightning", "arkade"], own))
      .toMatchObject([{ status: "fulfilled", value: invoice }, { status: "rejected" }]);
    expect(query?.get("amount")).toBe("20000");
    expect(query?.has("paymentOption")).toBe(false);
  });

  it.each([
    [],
    [{ id: "ln", type: "lightning", available: false }],
    [{ id: "token", type: "lightning", asset: "chain:token" }],
    [{ id: "ark", type: "arkade" }],
    [{ id: "", type: "lightning" }],
  ])("refuses an unadvertised, unavailable or token-only Lightning rail (%j)", async (...advertised) => {
    const request = payRequest(advertised as PaymentOption[]);
    const client = resultClient({ kind: "bolt11", pr: invoice });
    expect(await resolveLnurlRails(receiver(request), 20, ["lightning"], own, client))
      .toMatchObject([{ status: "rejected", reason: expect.objectContaining({ message: expect.stringContaining("no lightning rail") }) }]);
  });

  it("selects an available bitcoin option rather than a same-type token or disabled option", async () => {
    let selected: string | null = null;
    const client = createLnurlClient({ fetchImpl: async (url) => {
      selected = new URL(String(url)).searchParams.get("paymentOption");
      return jsonResponse({ paymentOption: selected, paymentDestination: own.arkade });
    } });
    const request = payRequest([
      { id: "token", type: "arkade", asset: "arkade:token" },
      { id: "disabled", type: "arkade", available: false },
      { id: "btc-ark", type: "arkade" },
    ]);
    expect(await resolveLnurlRails(receiver(request), 20, ["arkade"], own, client))
      .toEqual([{ status: "fulfilled", value: own.arkade }]);
    expect(selected).toBe("btc-ark");
  });

  it("keeps successful rails when one option's amount bounds reject the request", async () => {
    const client = createLnurlClient({ fetchImpl: async () => jsonResponse({ pr: invoice }) });
    const request = payRequest([options[0]!, { ...options[1]!, minSendable: 21_000 }]);
    expect(await resolveLnurlRails(receiver(request), 20, ["arkade", "lightning"], own, client))
      .toMatchObject([{ status: "rejected" }, { status: "fulfilled", value: invoice }]);
  });

  it("honors option bounds that extend beyond the default rail's limits", async () => {
    const request = { ...payRequest([{ ...options[1]!, minSendable: 10_000, maxSendable: 25_000 }]),
      minSendable: 1000, maxSendable: 5000 };
    const client = createLnurlClient({ fetchImpl: async () => jsonResponse({
      paymentOption: "ark", paymentDestination: own.arkade,
    }) });
    expect(await resolveLnurlRails(receiver(request), 20, ["arkade"], own, client))
      .toEqual([{ status: "fulfilled", value: own.arkade }]);
  });

  it("checks option bounds before invoking an injected client", async () => {
    const request = payRequest([{ ...options[1]!, maxSendable: 19_999 }]);
    const client = resultClient({ kind: "destination", paymentOption: "ark", paymentDestination: own.arkade });
    expect(await resolveLnurlRails(receiver(request), 20, ["arkade"], own, client))
      .toMatchObject([{ status: "rejected" }]);
  });

  it("isolates callback failures without losing successful destinations", async () => {
    const client = createLnurlClient({ fetchImpl: async (url) => {
      if (new URL(String(url)).searchParams.get("paymentOption") === "ln") throw new Error("offline");
      return jsonResponse({ paymentOption: "btc", paymentDestination: own.onchain });
    } });
    expect(await resolveLnurlRails(receiver(payRequest(options)), 20, ["lightning", "onchain"], own, client))
      .toMatchObject([{ status: "rejected" }, { status: "fulfilled", value: own.onchain }]);
  });

  it("rejects a payRequest failure for the entire operation", async () => {
    await expect(resolveLnurlRails({ payRequest: async () => { throw new Error("lookup failed"); } }, 20,
      ["lightning"], own, resultClient({ kind: "bolt11", pr: invoice }))).rejects.toThrow("lookup failed");
  });

  it.each([
    ["lightning", { kind: "destination", paymentOption: "ln", paymentDestination: own.onchain }],
    ["onchain", { kind: "bolt11", pr: invoice }],
    ["onchain", { kind: "destination", paymentOption: "btc" }],
    ["lightning", { kind: "bolt11", pr: "" }],
  ] as const)("rejects an empty or wrong-kind answer on %s", async (rail, answer) => {
    expect(await resolveLnurlRails(receiver(payRequest(options)), 20, [rail], own, resultClient(answer)))
      .toMatchObject([{ status: "rejected" }]);
  });

  it("requires the exact own boarding address", async () => {
    const client = resultClient({ kind: "destination", paymentOption: "btc", paymentDestination: "bcrt1qforeign" });
    expect(await resolveLnurlRails(receiver(payRequest(options)), 20, ["onchain"], own, client))
      .toMatchObject([{ status: "rejected" }]);
  });

  it.each(["lightning", "arkade", "onchain"] as const)("rejects a callback answering a different option on %s", async (rail) => {
    const client = createLnurlClient({ fetchImpl: async () => jsonResponse(rail === "lightning"
      ? { pr: invoice, paymentOption: "other" }
      : { paymentOption: "other", paymentDestination: own[rail] }) });
    expect(await resolveLnurlRails(receiver(payRequest(options)), 20, [rail], own, client))
      .toMatchObject([{ status: "rejected", reason: expect.objectContaining({ message: expect.stringContaining("other") }) }]);
  });

  it.each(["malformed", arkAddress(4), arkAddress(2, 3, "ark")])("rejects malformed or foreign-operator Arkade destinations (%s)", async (target) => {
    const client = resultClient({ kind: "destination", paymentOption: "ark", paymentDestination: target });
    expect(await resolveLnurlRails(receiver(payRequest(options)), 20, ["arkade"], own, client))
      .toMatchObject([{ status: "rejected" }]);
  });

  it("permits a different Arkade recipient on the same operator and network", async () => {
    const target = arkAddress(2, 5);
    const client = resultClient({ kind: "destination", paymentOption: "ark", paymentDestination: target });
    expect(await resolveLnurlRails(receiver(payRequest(options)), 20, ["arkade"], own, client))
      .toEqual([{ status: "fulfilled", value: target }]);
  });

  it("rejects an Arkade answer when the own reference address is malformed", async () => {
    const client = resultClient({ kind: "destination", paymentOption: "ark", paymentDestination: own.arkade });
    expect(await resolveLnurlRails(receiver(payRequest(options)), 20, ["arkade"], { ...own, arkade: "" }, client))
      .toMatchObject([{ status: "rejected" }]);
  });
});

describe("lnurlPayableRanges", () => {
  it("collects what a payer can send on the given rails, and whether one amount is all it takes", () => {
    const ranged = lnurlPayableRanges(payRequest([
      { id: "ln", type: "lightning", minSendable: 1000, maxSendable: 50_000_000 },
      { id: "ark", type: "arkade", minSendable: 330_000, maxSendable: 90_000_000 },
      { id: "btc", type: "onchain", minSendable: 330_000_000, maxSendable: 900_000_000 },
      { id: "odd", type: "lightning", minSendable: 1500, maxSendable: 1500 },
    ]));
    expect(ranged).toMatchObject({
      ranges: [{ type: "lightning", min: 1, max: 50_000 }, { type: "arkade", min: 330, max: 90_000 }],
      min: 1, max: 90_000, fixed: false,
    });
    expect([0, 1, 60_000, 90_001].map(ranged.accepts)).toEqual([false, true, true, false]);
    expect(lnurlPayableRanges(payRequest([{ id: "ln", type: "lightning", minSendable: 21_000, maxSendable: 21_000 }])))
      .toMatchObject({ min: 21, max: 21, fixed: true });
    expect(lnurlPayableRanges(payRequest([{ id: "btc", type: "onchain" }]))).toMatchObject({ ranges: [], min: 0, max: 0, fixed: false });
    expect(lnurlPayableRanges(payRequest([{ id: "btc", type: "onchain" }]), ["onchain"]).ranges).toEqual([{ type: "onchain", min: 1, max: 100 }]);
  });
});
