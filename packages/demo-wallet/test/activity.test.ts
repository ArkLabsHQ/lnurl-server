import { describe, it, expect } from "vitest";
import type { Activity } from "@arkade-os/sdk";
import type { StoredPayment } from "@arkade-os/lnurl-client";
import { mergeFeed } from "../src/activity.js";

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

const activity = (id: string, over: Partial<Activity> = {}): Activity => ({
  id,
  txs: [],
  amount: 1000,
  createdAt: 1_700_000_000_500,
  settled: false,
  ...over,
});

const TARGET = "lolita@lnurl.mutinynet.arkade.sh";

describe("mergeFeed, on a payment this wallet made", () => {
  const sendIntent = {
    label: `→ ${TARGET}`,
    kind: "lnurl-send",
    metadata: { target: TARGET, rail: "lnurl-arkade", delivered: "1000 sats", fee: "3 sats" },
  };

  it("says who was paid instead of only 'sent'", () => {
    const rows = mergeFeed([activity("sent:sendtx1", { amount: -1000, intent: sendIntent })], []);

    expect(rows[0]).toMatchObject({ kind: "wallet", label: `→ ${TARGET}` });
    expect(rows[0]!.details).toContainEqual(["paid to", TARGET]);
    expect(rows[0]!.details).toContainEqual(["rail", "lnurl-arkade"]);
    expect(rows[0]!.details).toContainEqual(["rail fee", "3 sats"]);
  });

  // The server's record is the richer source where it exists, and rendering both
  // would list the rail and the address twice on one row.
  it("leaves a row the server already describes to the server's record", () => {
    const p = payment({ payoutReference: "abc123" });
    const rows = mergeFeed(
      [activity(`lnurl:${p.key}`, { intent: { metadata: { target: "someone@else", rail: "wrong" } } })],
      [p],
    );

    expect(rows[0]!.details).not.toContainEqual(["paid to", "someone@else"]);
    expect(rows[0]!.details).toContainEqual(["paid to", ADDRESS]);
  });
});

describe("mergeFeed", () => {
  it("shows an absorbed payment once, on the wallet row", () => {
    const p = payment({ payoutReference: "abc123" });
    const rows = mergeFeed([activity(`lnurl:${p.key}`, { settled: true })], [p]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "wallet", label: "arkade" });
    // A wallet row carries no status: the money moved or it did not.
    expect(rows[0]!.status).toBeUndefined();
  });

  it("keeps a quote nobody paid, which has no transaction to enhance", () => {
    const unpaid = payment({ identifier: "id2", settled: false, payoutReference: null, amountMsat: 9_000_000 });
    const rows = mergeFeed([], [unpaid]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "quote", status: "pending" });
  });

  // The covenant window, caught live: the server HAS observed the payment, so it
  // is settled, but only the later sweep records a payout to join on.
  it("folds a settled quote that has no payout reference yet", () => {
    const p = payment({ settled: true, payoutReference: null, amountMsat: 1_000_000, createdAt: 1_700_000_000_000 });
    const rows = mergeFeed([activity("plain", { amount: 1000, createdAt: 1_700_000_000_500 })], [p]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "wallet", label: "arkade" });
  });

  it("folds an unobserved quote into the payment that already arrived", () => {
    const p = payment({ settled: false, payoutReference: null, amountMsat: 1_000_000, createdAt: 1_700_000_000_000 });
    const rows = mergeFeed([activity("plain", { amount: 1000, createdAt: 1_700_000_000_500 })], [p]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "wallet", label: "arkade" });
    expect(rows[0]!.details).toContainEqual(["matched", expect.stringContaining("amount and timing")]);
  });

  it("never folds a quote into a payment smaller than it was quoted for", () => {
    const p = payment({ settled: false, payoutReference: null, amountMsat: 5_000_000, createdAt: 1_700_000_000_000 });
    const rows = mergeFeed([activity("plain", { amount: 1000, createdAt: 1_700_000_000_500 })], [p]);

    expect(rows).toHaveLength(2);
  });

  it("reports the rail's cut as the gap between quoted and received", () => {
    const p = payment({ payoutReference: "abc123", amountMsat: 1_000_000 });
    const rows = mergeFeed([activity(`lnurl:${p.key}`, { amount: 947 })], [p]);

    expect(rows[0]!.details).toContainEqual(["rail fee", "53 sats"]);
  });
});
