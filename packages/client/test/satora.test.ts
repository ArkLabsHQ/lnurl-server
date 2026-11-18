import { bech32m } from "@scure/base";
import { describe, expect, it } from "vitest";
import { satoraPaymentUrl, type DestinationResult } from "../src/index.js";

const recipient = bech32m.encode("ark", bech32m.toWords(new Uint8Array(65)), 120);
const checkout = `https://app.satora.io/polygon:USDC/arkade:BTC?targetAmount=125000&address=${recipient}`;
const answer: DestinationResult = {
  kind: "destination", paymentOption: "satora", paymentDestination: recipient, paymentURI: checkout,
};

describe("Satora checkout", () => {
  it("returns the hosted checkout for the requested Arkade payment", () => {
    expect(satoraPaymentUrl(answer, 125_000)).toBe(checkout);
  });

  it.each([
    checkout.replace("app.satora.io", "app.satora.io.example"),
    checkout.replace("https:", "http:"),
    checkout.replace("arkade:BTC", "bitcoin:BTC"),
    checkout.replace("125000", "124999"),
    checkout.replace(`address=${recipient}`, "address=elsewhere"),
    `${checkout}&address=elsewhere`,
    `${checkout}&sourceAmount=1`,
    `${checkout}#other`,
    "not a URL",
  ])("rejects checkout %s", (paymentURI) => {
    expect(() => satoraPaymentUrl({ ...answer, paymentURI }, 125_000)).toThrow(/does not match/);
  });

  it("rejects a checkout without a mainnet Arkade address or a whole-sat amount", () => {
    const testnet = bech32m.encode("tark", bech32m.toWords(new Uint8Array(65)), 120);
    expect(() => satoraPaymentUrl({ ...answer, paymentDestination: testnet, paymentURI: checkout.replace(recipient, testnet) }, 125_000))
      .toThrow(/does not match/);
    expect(() => satoraPaymentUrl(answer, 125_000.5)).toThrow(/does not match/);
  });

  it("refuses a callback that answered for a different rail", () => {
    expect(() => satoraPaymentUrl({ ...answer, paymentOption: "arkade" }, 125_000)).toThrow(/no Satora checkout/);
  });
});
