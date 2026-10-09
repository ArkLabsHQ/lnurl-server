import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { LIGHTNING_RECEIVE_PAIR, type RfqQuote } from "@arkade-os/swap/protocol";
import { assertReceivable } from "../src/vendor/swap-rfq.js";

// Copied from @arkade-os/swap 0.1.0-rc.20, packages/swap/test/rfqReceive.test.ts.

const key = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill));
const RFQ_ID = "a1".repeat(32);
const SOLVER = key(1);
const NOW = Math.floor(Date.now() / 1000);
const VALID_UNTIL = NOW + 3600;
const REFUND_LOCKTIME = NOW + 2 * 3600;
const INVOICE_EXPIRES_AT = NOW + 600;

describe("assertReceivable", () => {
  const quote = (over: Partial<RfqQuote> = {}): RfqQuote =>
    ({
      v: 1,
      type: "rfq_quote",
      rfq_id: RFQ_ID,
      pair: LIGHTNING_RECEIVE_PAIR,
      from_amount: 5_000,
      to_amount: 4_950,
      solver_pubkey: hex.encode(SOLVER),
      valid_until: VALID_UNTIL,
      refund_locktime: REFUND_LOCKTIME,
      profile: {},
      ...over,
    }) as RfqQuote;

  it("passes a live quote whose refund leaves room to claim", () => {
    assertReceivable({ quote: quote(), payDeadline: INVOICE_EXPIRES_AT, now: NOW });
  });

  it("refuses once the pay deadline has passed", () => {
    expect(() => assertReceivable({ quote: quote(), payDeadline: NOW, now: NOW })).toThrow(
      expect.objectContaining({ reason: "quote_expired" }),
    );
  });

  it("refuses a quote carrying no refund_locktime", () => {
    expect(() =>
      assertReceivable({
        quote: quote({ refund_locktime: undefined }),
        payDeadline: INVOICE_EXPIRES_AT,
        now: NOW,
      }),
    ).toThrow(expect.objectContaining({ reason: "missing_refund_locktime" }));
  });

  // Both sides of the floor are pinned, so a `<` that slips to `<=` fails here.
  it("refuses when a last-moment payment would leave no claim window", () => {
    expect(() =>
      assertReceivable({
        quote: quote({ refund_locktime: INVOICE_EXPIRES_AT + 1_799 }),
        payDeadline: INVOICE_EXPIRES_AT,
        now: NOW,
      }),
    ).toThrow(expect.objectContaining({ reason: "claim_window_too_short" }));
    assertReceivable({
      quote: quote({ refund_locktime: INVOICE_EXPIRES_AT + 1_800 }),
      payDeadline: INVOICE_EXPIRES_AT,
      now: NOW,
    });
  });

  it("applies maxPayAmount to from_amount only when given", () => {
    assertReceivable({
      quote: quote(),
      payDeadline: INVOICE_EXPIRES_AT,
      now: NOW,
      maxPayAmount: 5_000,
    });
    expect(() =>
      assertReceivable({
        quote: quote(),
        payDeadline: INVOICE_EXPIRES_AT,
        now: NOW,
        maxPayAmount: 4_999,
      }),
    ).toThrow(expect.objectContaining({ reason: "price_too_high" }));
  });

  // A non-finite value fails every comparison, which would delete its gate rather than trip it.
  it("refuses a non-finite input instead of silently dropping its gate", () => {
    expect(() => assertReceivable({ quote: quote(), payDeadline: NaN, now: NOW })).toThrow(
      expect.objectContaining({ reason: "quote_malformed" }),
    );
    expect(() =>
      assertReceivable({
        quote: quote({ refund_locktime: NaN }),
        payDeadline: INVOICE_EXPIRES_AT,
        now: NOW,
      }),
    ).toThrow(expect.objectContaining({ reason: "quote_malformed" }));
    expect(() =>
      assertReceivable({
        quote: quote(),
        payDeadline: INVOICE_EXPIRES_AT,
        now: NOW,
        maxPayAmount: NaN,
      }),
    ).toThrow(expect.objectContaining({ reason: "invalid_gate_input" }));
    expect(() =>
      assertReceivable({
        quote: quote(),
        payDeadline: INVOICE_EXPIRES_AT,
        now: NOW,
        minClaimWindowSeconds: NaN,
      }),
    ).toThrow(expect.objectContaining({ reason: "invalid_gate_input" }));
    expect(() =>
      assertReceivable({ quote: quote(), payDeadline: INVOICE_EXPIRES_AT, now: NaN }),
    ).toThrow(expect.objectContaining({ reason: "invalid_gate_input" }));
  });
});
