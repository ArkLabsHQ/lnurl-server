import { describe, it, expect } from "vitest";
import { TxType, type ArkTransaction } from "@arkade-os/sdk";
import type { StoredPayment } from "../src/sync.js";
import { absorbedPaymentKey, lnurlActivityResolver, railOf, sentActivityResolver } from "../src/activity.js";
import type { SentPayment } from "../src/activity.js";

const ADDRESS = "test2@lnurl.mutinynet.arkade.sh";

const payment = (over: Partial<StoredPayment>): StoredPayment => ({
  key: `https://lnurl.example|${over.identifier ?? "id1"}`,
  baseUrl: "https://lnurl.example",
  domain: "lnurl.mutinynet.arkade.sh",
  lightningAddress: ADDRESS,
  handle: "test2",
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

const TARGET = "lolita@lnurl.mutinynet.arkade.sh";

const sent = (over: Partial<SentPayment> = {}): SentPayment => ({
  txid: "sendtx1",
  target: TARGET,
  railId: "lnurl-arkade",
  amountSat: 1000,
  feeSat: 0,
  createdAt: 1_700_000_000_000,
  ...over,
});

describe("sentActivityResolver", () => {
  it("names the address this wallet paid, from what it recorded at send time", async () => {
    const resolver = sentActivityResolver(() => [sent({ feeSat: 3, swapId: "sw1" })]);
    await resolver.prepare?.();

    expect(resolver.resolve(tx("sendtx1"))).toEqual([{
      groupId: "sent:sendtx1",
      label: `→ ${TARGET}`,
      kind: "lnurl-send",
      metadata: { target: TARGET, rail: "lnurl-arkade", delivered: "1000 sats", fee: "3 sats", swap: "sw1" },
    }]);
  });

  it("leaves a transaction it has no record of plain", async () => {
    const resolver = sentActivityResolver(() => [sent()]);
    await resolver.prepare?.();
    expect(resolver.resolve(tx("some-other-tx"))).toBeUndefined();
  });

  it("reports whether the receiver confirmed, once verify has answered", async () => {
    const yes = sentActivityResolver(() => [sent({ receiverConfirmed: true })]);
    await yes.prepare?.();
    expect(yes.resolve(tx("sendtx1"))).toMatchObject([{ metadata: { receiver: "confirmed settled" } }]);

    const no = sentActivityResolver(() => [sent({ receiverConfirmed: false })]);
    await no.prepare?.();
    expect(no.resolve(tx("sendtx1"))).toMatchObject([{ metadata: { receiver: "has not confirmed" } }]);
  });

  // Silence is the honest answer before verify replies; "has not confirmed" would
  // read as a negative result rather than an absent one.
  it("says nothing about the receiver before verify has answered", async () => {
    const resolver = sentActivityResolver(() => [sent()]);
    await resolver.prepare?.();
    expect(resolver.resolve(tx("sendtx1"))![0]!.metadata).not.toHaveProperty("receiver");
  });
});
