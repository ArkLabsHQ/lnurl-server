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

  const TOKENS = [{ optionId: "ff-usdtarbitrum", ffCode: "USDTARBITRUM" }, { optionId: "ff-usdttrc", ffCode: "USDTTRC" }];

  it("resolves an advertised ff- id to its FF code", () => {
    expect(resolvePaymentOption("ff-usdttrc", withArkade, TOKENS)).toEqual({ kind: "fixedfloat", optionId: "ff-usdttrc", ffCode: "USDTTRC" });
    expect(resolvePaymentOption("FF-USDTTRC", withArkade, TOKENS)).toEqual({ kind: "fixedfloat", optionId: "ff-usdttrc", ffCode: "USDTTRC" });
  });

  it("errors on an ff- id that is not currently advertised", () => {
    expect(resolvePaymentOption("ff-usdcsol", withArkade, TOKENS)).toEqual({ kind: "error", reason: "Unsupported paymentOption" });
    expect(resolvePaymentOption("ff-usdttrc", withArkade)).toEqual({ kind: "error", reason: "Unsupported paymentOption" });
    expect(resolvePaymentOption("ff-usdttrc", noArkade, TOKENS)).toEqual({ kind: "error", reason: "Unsupported paymentOption" });
  });

  it("errors on an ff- id the address has disabled", () => {
    expect(resolvePaymentOption("ff-usdttrc", { ...withArkade, disabledRails: ["fixedfloat"] }, TOKENS))
      .toEqual({ kind: "error", reason: "paymentOption ff-usdttrc is disabled for this address" });
  });

  it("still resolves lightning, arkade, onchain and the absent case exactly as before", () => {
    const boarding = { ...withArkade, boardingAddress: "tb1qboarding" };
    expect(resolvePaymentOption(undefined, boarding, TOKENS)).toEqual({ kind: "lightning" });
    expect(resolvePaymentOption("lightning", boarding, TOKENS)).toEqual({ kind: "lightning" });
    expect(resolvePaymentOption("arkade", boarding, TOKENS)).toEqual({ kind: "destination", paymentOption: "arkade", paymentDestination: "ark1xyz" });
    expect(resolvePaymentOption("onchain", boarding, TOKENS)).toEqual({ kind: "destination", paymentOption: "onchain", paymentDestination: "tb1qboarding" });
  });

  it("normalizes option id case (ids are canonical lowercase)", () => {
    expect(resolvePaymentOption("Arkade", withArkade)).toEqual({
      kind: "destination",
      paymentOption: "arkade",
      paymentDestination: "ark1xyz",
    });
    expect(resolvePaymentOption("LIGHTNING", noArkade)).toEqual({ kind: "lightning" });
  });

  const withMethod = { ...withArkade, paymentMethods: [{ type: "shielded", destination: "shrol21abc" }] };

  it("resolves a registered option to its destination, before the CAIP-19 branch", () => {
    expect(resolvePaymentOption("registered:shielded", withMethod, [], "mutinynet")).toEqual({
      kind: "registered", paymentOption: "registered:shielded", methodType: "shielded", paymentDestination: "shrol21abc",
    });
  });

  it("resolves a registered option with no network configured", () => {
    expect(resolvePaymentOption("registered:shielded", withMethod, []).kind).toBe("registered");
  });

  it("accepts the id in any case the payer sends", () => {
    expect(resolvePaymentOption("Registered:Shielded", withMethod, [], "mutinynet").kind).toBe("registered");
  });

  it("refuses an unregistered type and a bare prefix", () => {
    for (const id of ["registered:nope", "registered:", "registered"]) {
      expect(resolvePaymentOption(id, withMethod, [], "mutinynet")).toEqual({ kind: "error", reason: "Unsupported paymentOption" });
    }
  });

  it("still refuses a real CAIP-19 id on the wrong network", () => {
    expect(resolvePaymentOption("arkade:bitcoin/slip44:0", withMethod, [], "mutinynet").kind).toBe("error");
  });
});
