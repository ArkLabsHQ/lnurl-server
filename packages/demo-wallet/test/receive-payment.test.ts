import { describe, expect, it } from "vitest";
import { tokenOptions, type DestinationResult, type PayRequest } from "@arkade-os/lnurl-client";
import { tokenDeposit, tokenLabel } from "../src/receive-payment.js";

const recipient = `0x${"12".repeat(20)}`;
const contract = `0x${"34".repeat(20)}`;
const request: PayRequest = {
  tag: "payRequest", callback: "https://example.com/callback", minSendable: 1000,
  maxSendable: 100_000_000, metadata: "[]", source: { surface: "address", url: "https://example.com" },
  units: [{ code: "USDC", name: "USD Coin", decimals: 6 }],
  paymentOptions: [
    { id: "ff-usdcpolygon", type: "eip155", asset: `eip155:137/erc20:${contract}`, unit: "USDC", provider: "FixedFloat" },
    { id: "satora-usdcpolygon", type: "eip155", asset: `eip155:137/erc20:${contract}`, unit: "USDC", provider: "Satora" },
  ],
};
const [fixedFloat, satora] = tokenOptions(request);
const quoted: DestinationResult = {
  kind: "destination", paymentOption: "satora-usdcpolygon", paymentDestination: recipient,
  paymentURI: `ethereum:${contract}@137/transfer?address=${recipient}&uint256=1250001`,
  paymentQuote: {
    requested: { amount: "1000", unit: "msat" },
    payment: { amount: "1250001", unit: "USDC" },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  },
};

describe("in-page token deposits", () => {
  it("uses the exact Polygon USDC transfer for Satora's quote and QR", () => {
    expect(tokenDeposit(satora!, quoted)).toMatchObject({
      amount: "1.250001", destination: recipient, value: quoted.paymentURI,
      expiresAt: Date.parse(quoted.paymentQuote!.expiresAt!),
    });
  });

  it("keeps quotes distinct when both providers offer the same asset", () => {
    expect(tokenLabel(fixedFloat!)).toBe("FixedFloat · USDC on Polygon");
    expect(tokenLabel(satora!)).toBe("Satora · USDC on Polygon");
    expect(() => tokenDeposit(fixedFloat!, quoted)).toThrow(/answered for satora-usdcpolygon/);
  });

  it("refuses a required deposit memo the demo QR cannot carry", () => {
    expect(() => tokenDeposit(satora!, { ...quoted, paymentDestinationTag: "order-42" }))
      .toThrow(/memo/);
  });

  it("rejects expired and non-token answers before displaying the QR", () => {
    expect(() => tokenDeposit(satora!, { ...quoted, paymentQuote: { ...quoted.paymentQuote!, expiresAt: "2000-01-01T00:00:00Z" } }))
      .toThrow(/future expiry/);
    expect(() => tokenDeposit(satora!, { kind: "bolt11", pr: "invoice" })).toThrow(/no token deposit/);
    expect(() => tokenDeposit(satora!, { ...quoted, paymentDestination: "ark1payout" })).toThrow(/no eip155 address/);
  });
});
