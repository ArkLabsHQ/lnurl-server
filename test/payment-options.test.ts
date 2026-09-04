import { describe, it, expect } from "vitest";
import { advertisedOptions, resolvePaymentOption } from "../src/payment-options.js";

const withArkade = { arkadeAddress: "ark1xyz", claimPublicKey: "ab".repeat(33) };
const noArkade = { arkadeAddress: null, claimPublicKey: null };

describe("advertisedOptions", () => {
  it("offers lightning + arkade when an Arkade identity is registered", () => {
    expect(advertisedOptions(withArkade)).toEqual([
      { id: "lightning", type: "lightning" },
      { id: "arkade", type: "arkade" },
    ]);
  });

  it("omits paymentOptions entirely without an Arkade identity (stays pure LUD-06)", () => {
    expect(advertisedOptions(noArkade)).toEqual([]);
  });
});

describe("resolvePaymentOption", () => {
  it("treats absent / lightning as the default BOLT11 flow", () => {
    expect(resolvePaymentOption(undefined, withArkade)).toEqual({ kind: "lightning" });
    expect(resolvePaymentOption("lightning", noArkade)).toEqual({ kind: "lightning" });
  });

  it("resolves arkade to the registered Arkade destination", () => {
    expect(resolvePaymentOption("arkade", withArkade)).toEqual({
      kind: "destination",
      paymentOption: "arkade",
      paymentDestination: "ark1xyz",
    });
  });

  it("errors on arkade without an identity, and on unknown options", () => {
    expect(resolvePaymentOption("arkade", noArkade)).toEqual({ kind: "error", reason: "Unsupported paymentOption" });
    expect(resolvePaymentOption("onchain", withArkade)).toEqual({ kind: "error", reason: "Unsupported paymentOption" });
  });

  it("normalizes option id case (ids are canonical lowercase)", () => {
    expect(resolvePaymentOption("Arkade", withArkade)).toEqual({
      kind: "destination",
      paymentOption: "arkade",
      paymentDestination: "ark1xyz",
    });
    expect(resolvePaymentOption("LIGHTNING", noArkade)).toEqual({ kind: "lightning" });
  });
});
