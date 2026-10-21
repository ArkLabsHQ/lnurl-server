import { describe, it, expect } from "vitest";
import { TxType, type ArkTransaction } from "@arkade-os/sdk";
import type { StoredPayment } from "../src/sync.js";
import {
  absorbedPaymentKey,
  lnurlActivity,
  lnurlActivityResolver,
  LNURL_ACTIVITY_KIND,
  railOf,
  SENT_ACTIVITY_KIND,
  sentActivityResolver,
} from "../src/activity.js";
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

  it("shows what a payer asked for in a unit", async () => {
    const resolver = lnurlActivityResolver(() => [payment({ payoutReference: "abc123", quote: { amount: "500", unit: "USD", decimals: 2 } })]);
    await resolver.prepare?.();
    expect(resolver.resolve(tx("abc123"))?.[0]?.metadata).toMatchObject({ requested: "5.00 USD" });
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

  it("awaits an async source on every prepare, so a sync after construction is seen", async () => {
    let stored: StoredPayment[] = [];
    const resolver = lnurlActivityResolver(async () => stored);
    await resolver.prepare?.();
    expect(resolver.resolve(tx("abc123"))).toBeUndefined();

    stored = [payment({ payoutReference: "abc123" })];
    await resolver.prepare?.();
    expect(resolver.resolve(tx("abc123"))).toMatchObject([{ kind: "lnurl" }]);
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

  it("shows what this wallet asked to pay in a unit", async () => {
    const resolver = sentActivityResolver(() => [sent({ quote: { amount: "1234567", unit: "USDT", decimals: 6 } })]);
    await resolver.prepare?.();
    expect(resolver.resolve(tx("sendtx1"))?.[0]?.metadata).toMatchObject({ delivered: "1000 sats", requested: "1.234567 USDT" });
  });

  it("leaves a transaction it has no record of plain", async () => {
    const resolver = sentActivityResolver(() => [sent()]);
    await resolver.prepare?.();
    expect(resolver.resolve(tx("some-other-tx"))).toBeUndefined();
  });

  it("awaits an async source", async () => {
    const resolver = sentActivityResolver(async () => [sent()]);
    await resolver.prepare?.();
    expect(resolver.resolve(tx("sendtx1"))).toMatchObject([{ kind: "lnurl-send" }]);
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

describe("lnurlActivity", () => {
  const asActivity = (membership: { groupId: string; kind?: string; metadata?: Record<string, unknown> }) =>
    ({ id: membership.groupId, intent: { kind: membership.kind, metadata: membership.metadata } });

  it("reads what each resolver recorded, typed, and nothing for a row neither tagged", async () => {
    const received = lnurlActivityResolver(() => [payment({ payoutReference: "abc123" })]);
    const nameless = lnurlActivityResolver(() => [payment({ payoutReference: "def456", lightningAddress: null })]);
    const sends = sentActivityResolver(() => [sent()]);
    await Promise.all([received.prepare?.(), nameless.prepare?.(), sends.prepare?.()]);
    const [r] = received.resolve(tx("abc123"))!;
    const [n] = nameless.resolve(tx("def456"))!;
    const [s] = sends.resolve(tx("sendtx1"))!;

    expect(r!.kind).toBe(LNURL_ACTIVITY_KIND);
    expect(s!.kind).toBe(SENT_ACTIVITY_KIND);
    expect(lnurlActivity(asActivity(r!))).toEqual({ direction: "received", address: ADDRESS, rail: "arkade" });
    expect(lnurlActivity(asActivity(n!))).toEqual({ direction: "received", rail: "arkade" });
    expect(lnurlActivity(asActivity(s!))).toEqual({ direction: "sent", address: TARGET, rail: "lnurl-arkade" });
    expect(lnurlActivity({ id: "boarding:deadbeef" })).toBeUndefined();
  });
});
