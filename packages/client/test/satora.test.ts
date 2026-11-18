import { bech32m } from "@scure/base";
import { describe, expect, it } from "vitest";
import { satoraPaymentTarget, type DestinationResult } from "../src/index.js";

function address(prefix: string, version = 0): string {
  const bytes = new Uint8Array(65);
  bytes[0] = version;
  return bech32m.encode(prefix, bech32m.toWords(bytes), 120);
}

const recipient = address("ark");
const answer: DestinationResult = {
  kind: "destination", paymentOption: "satora", paymentDestination: recipient,
  verify: "https://lnurl.example.com/lnurl/verify/payout",
  verifyBatch: "https://lnurl.example.com/lnurl/verifyBatch",
  expiresAt: 1,
};

describe("Satora payment target", () => {
  it("returns the payout and verification data, including expiry for recovery", () => {
    expect(satoraPaymentTarget(answer, 125_000)).toEqual({
      destination: recipient, amountSat: 125_000,
      verify: answer.verify, verifyBatch: answer.verifyBatch, expiresAt: 1,
    });
  });

  it.each([address("tark"), address("ark", 1), `${recipient}wrong`])("rejects an unsupported destination %s", (paymentDestination) => {
    expect(() => satoraPaymentTarget({ ...answer, paymentDestination }, 125_000)).toThrow(/invalid mainnet Arkade destination/);
  });

  it.each([0, 125_000.5, Number.MAX_SAFE_INTEGER])("rejects an unsupported amount %s", (amountSat) => {
    expect(() => satoraPaymentTarget(answer, amountSat)).toThrow(/positive whole number of satoshis/);
  });

  it.each([
    undefined, "/lnurl/verify/payout", "http://lnurl.example.com/verify",
    "https://user:pass@lnurl.example.com/verify", "https://lnurl.example.com/verify#anchor",
  ])("rejects an invalid verification endpoint %s", (verify) => {
    expect(() => satoraPaymentTarget({ ...answer, verify }, 125_000)).toThrow(/invalid Satora verification URL/);
  });

  it("allows a loopback endpoint for local testing", () => {
    const verify = "http://127.0.0.1:3000/lnurl/verify/payout";
    expect(satoraPaymentTarget({ ...answer, verify }, 125_000).verify).toBe(verify);
  });

  it("rejects a malformed optional verification endpoint or expiry", () => {
    expect(() => satoraPaymentTarget({ ...answer, verifyBatch: "not a URL" }, 125_000)).toThrow(/invalid Satora verification URL/);
    expect(() => satoraPaymentTarget({ ...answer, expiresAt: -1 }, 125_000)).toThrow(/invalid Satora expiry/);
  });

  it("refuses a callback that answered for a different rail", () => {
    expect(() => satoraPaymentTarget({ ...answer, paymentOption: "arkade" }, 125_000)).toThrow(/no Satora payment target/);
  });
});
