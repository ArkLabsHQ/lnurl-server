import { describe, expect, it } from "vitest";
import type { DestinationResult, PayRequest } from "@arkade-os/lnurl-client";
import { receivePaymentValue } from "../src/receive-payment.js";

const recipient = `0x${"12".repeat(20)}`;
const contract = `0x${"34".repeat(20)}`;
const request: PayRequest = {
  tag: "payRequest", callback: "https://example.com/callback", minSendable: 1000,
  maxSendable: 100_000_000, metadata: "[]", source: { surface: "address", url: "https://example.com" },
  units: [{ code: "USDT", name: "Tether", decimals: 6 }],
  paymentOptions: [{ id: "token", type: "eip155", asset: `eip155:1/erc20:${contract}`, unit: "USDT" }],
};
const quoted: DestinationResult = {
  kind: "destination", paymentOption: "token", paymentDestination: recipient,
  paymentURI: `ethereum:${contract}@1/transfer?address=${recipient}&uint256=1000000`,
  paymentQuote: { requested: { amount: "1000", unit: "msat" }, payment: { amount: "1000000", unit: "USDT" } },
};

describe("receive payment values", () => {
  it("uses a verified token transfer URI for the QR", () => {
    expect(receivePaymentValue(request, "token", quoted)).toBe(quoted.paymentURI);
  });

  it("refuses a required deposit memo the demo QR cannot carry", () => {
    expect(() => receivePaymentValue(request, "token", { ...quoted, paymentDestinationTag: "order-42" }))
      .toThrow(/memo/);
  });

  it("keeps Bitcoin destinations and invoices in their existing form", () => {
    expect(receivePaymentValue(request, "onchain", { kind: "destination", paymentOption: "onchain", paymentDestination: "btc-address" }))
      .toBe("btc-address");
    expect(receivePaymentValue(request, "lightning", { kind: "bolt11", pr: "invoice" })).toBe("invoice");
  });
});
