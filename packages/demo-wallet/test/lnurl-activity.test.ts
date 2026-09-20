import { describe, it, expect } from "vitest";
import { TxType, type Activity, type ArkTransaction } from "@arkade-os/sdk";
import type { StoredPayment } from "@arkade-os/lnurl-client";
import { absorbedPaymentKey, lnurlActivityResolver, railOf } from "../src/lnurl-activity.js";
import { mergeFeed } from "../src/activity.js";

const ADDRESS = "test2@lnurl.mutinynet.arkade.sh";

const payment = (over: Partial<StoredPayment>): StoredPayment => ({
  key: `https://lnurl.example|${over.identifier ?? "id1"}`,
  baseUrl: "https://lnurl.example",
  domain: "lnurl.mutinynet.arkade.sh",
  lightningAddress: ADDRESS,
  identifier: "id1",
  kind: "destination",
  settled: true,
  amountMsat: 1_000_000,
  createdAt: 1_700_000_000_000,
  settledAt: 1_700_000_001_000,
  swapId: null,
  paymentReference: null,
  payoutReference: null,
  preimage: null,
  paymentOption: "arkade",
  covenantScript: null,
  ...over,
});

const tx = (arkTxid: string, over: Partial<ArkTransaction> = {}): ArkTransaction => ({
  key: { boardingTxid: "", commitmentTxid: "", arkTxid },
  type: TxType.TxReceived,
  amount: 1000,
  settled: false,
  createdAt: 1_700_000_000_500,
  ...over,
});

const activity = (id: string, over: Partial<Activity> = {}): Activity => ({
  id,
  txs: [],
  amount: 1000,
  createdAt: 1_700_000_000_500,
  settled: false,
  ...over,
});

describe("lnurlActivityResolver", () => {
  it("labels the wallet's own transaction with the rail the server recorded", async () => {
    const p = payment({ payoutReference: "abc123", paymentOption: "arkade" });
    const resolver = lnurlActivityResolver(() => [p]);
    await resolver.prepare?.();

    expect(resolver.resolve(tx("abc123"))).toEqual([{
      groupId: `lnurl:${p.key}`,
      label: `arkade · ${ADDRESS}`,
      kind: "lnurl",
      metadata: { rail: "arkade", lightningAddress: ADDRESS, identifier: "id1", verified: true },
    }]);
  });

  it("leaves a transaction the server never observed plain", async () => {
    const resolver = lnurlActivityResolver(() => [payment({ payoutReference: "abc123" })]);
    await resolver.prepare?.();
    expect(resolver.resolve(tx("something-else"))).toBeUndefined();
  });

  it("never matches a payment that has not credited the user yet", async () => {
    const resolver = lnurlActivityResolver(() => [payment({ kind: "bolt11", payoutReference: null })]);
    await resolver.prepare?.();
    expect(resolver.resolve(tx(""))).toBeUndefined();
  });

  it("labels a Lightning swap by the claim that credited it", async () => {
    const p = payment({ kind: "bolt11", payoutReference: "claim-tx" });
    const resolver = lnurlActivityResolver(() => [p]);
    await resolver.prepare?.();
    expect(resolver.resolve(tx("claim-tx"))).toMatchObject([{ label: `lightning · ${ADDRESS}` }]);
  });

  it("labels a covenant payment by its sweep, not by what was observed", async () => {
    const p = payment({ paymentReference: "covenant-tx", payoutReference: "sweep-tx" });
    const resolver = lnurlActivityResolver(() => [p]);
    await resolver.prepare?.();
    expect(resolver.resolve(tx("covenant-tx"))).toBeUndefined();
    expect(resolver.resolve(tx("sweep-tx"))).toMatchObject([{ kind: "lnurl" }]);
  });

  it("reads back the payment an activity absorbed", () => {
    expect(absorbedPaymentKey("lnurl:https://x|id1")).toBe("https://x|id1");
    expect(absorbedPaymentKey("boarding:deadbeef")).toBeUndefined();
  });

  it("names the rail from the payment's own fields", () => {
    expect(railOf(payment({ kind: "bolt11" }))).toBe("lightning");
    expect(railOf(payment({ paymentOption: "onchain" }))).toBe("onchain");
    expect(railOf(payment({ paymentOption: null }))).toBe("destination");
  });
});

describe("mergeFeed", () => {
  it("shows an absorbed payment once, on the wallet row", () => {
    const p = payment({ payoutReference: "abc123" });
    const rows = mergeFeed([activity(`lnurl:${p.key}`, { settled: true })], [p]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("wallet");
  });

  it("keeps a quote nobody paid, which has no transaction to enhance", () => {
    const unpaid = payment({ identifier: "id2", settled: false, payoutReference: null });
    const rows = mergeFeed([], [unpaid]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "lnurl", status: "pending" });
  });

  it("keeps a Lightning payment beside the wallet row it cannot be joined to", () => {
    const swap = payment({ identifier: "id3", kind: "bolt11", payoutReference: null });
    const rows = mergeFeed([activity("plain-wallet-row")], [swap]);

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.source).sort()).toEqual(["lnurl", "wallet"]);
  });
});
