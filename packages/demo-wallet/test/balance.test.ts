import { describe, it, expect } from "vitest";
import type { WalletBalance } from "@arkade-os/sdk";
import { balanceView } from "../src/balance.js";

const balance = (over: Partial<WalletBalance>): WalletBalance => ({
  boarding: { confirmed: 0, unconfirmed: 0, total: 0 },
  settled: 0, preconfirmed: 0, available: 0, gated: 0, intentLocked: 0,
  recoverable: 0, total: 0,
  ...over,
} as WalletBalance);

describe("balanceView", () => {
  it("shows nothing before the first read rather than a confident zero", () => {
    expect(balanceView(null)).toEqual({ sats: null });
  });

  it("is one figure when nothing is in flight", () => {
    expect(balanceView(balance({ available: 4_200 }))).toEqual({ sats: 4_200 });
  });

  it("says what is settling when an offboard has locked the whole balance", () => {
    expect(balanceView(balance({ available: 0, settled: 985_377, intentLocked: 985_377 })))
      .toEqual({ sats: 0, settling: 985_377 });
  });

  it("reports a partial lock alongside what is still spendable", () => {
    expect(balanceView(balance({ available: 3_000, intentLocked: 12_000 })))
      .toEqual({ sats: 3_000, settling: 12_000 });
  });

  it("stays quiet when the wallet reports nothing in flight", () => {
    expect(balanceView(balance({ available: 500, intentLocked: 0 }))).toEqual({ sats: 500 });
  });
});
