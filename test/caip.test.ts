import { describe, it, expect } from "vitest";
import { caip19Id, matchCaip19Id, isRailType } from "../src/caip.js";
import { advertisedRailOptions } from "../src/rails.js";
import { resolvePaymentOption } from "../src/payment-options.js";

const ADDRESS = {
  arkadeAddress: "tark1qexample",
  claimPublicKey: "02".repeat(16),
  boardingAddress: "tb1qexample",
  disabledRails: [] as const,
};
const CAPS = { offlineSwapCreator: true, discoveryReady: true, covenantDestinations: false, arkServerUrl: "http://arkd" };

describe("caip19Id", () => {
  it("pairs slip44:0 with mainnet and slip44:1 with every testnet", () => {
    expect(caip19Id("arkade", "bitcoin")).toBe("arkade:bitcoin/slip44:0");
    expect(caip19Id("lightning", "mutinynet")).toBe("bolt11:mutinynet/slip44:1");
    expect(caip19Id("onchain", "signet")).toBe("bitcoin:signet/slip44:1");
    expect(caip19Id("onchain", "regtest")).toBe("bitcoin:regtest/slip44:1");
  });

  it("uses the chain namespace intent-solver files the corridor under", () => {
    expect(caip19Id("lightning", "bitcoin").startsWith("bolt11:")).toBe(true);
    expect(caip19Id("onchain", "bitcoin").startsWith("bitcoin:")).toBe(true);
  });

  it("recognises exactly the three rail types", () => {
    expect(["lightning", "arkade", "onchain"].every(isRailType)).toBe(true);
    expect(isRailType("covenant")).toBe(false);
  });
});

describe("matchCaip19Id", () => {
  it("round-trips every rail on its own network", () => {
    for (const type of ["lightning", "arkade", "onchain"] as const) {
      expect(matchCaip19Id(caip19Id(type, "mutinynet"), "mutinynet")).toEqual({ kind: "rail", type });
    }
  });

  it("tells a wrong network apart from a malformed id", () => {
    expect(matchCaip19Id("arkade:bitcoin/slip44:0", "mutinynet")).toEqual({ kind: "wrong-network", got: "bitcoin" });
    expect(matchCaip19Id("arkade:nonsense/slip44:1", "mutinynet")).toEqual({ kind: "unknown" });
    expect(matchCaip19Id("nonsense:mutinynet/slip44:1", "mutinynet")).toEqual({ kind: "unknown" });
  });

  it("rejects an id with extra segments instead of dropping the tail", () => {
    expect(matchCaip19Id("bolt11:bitcoin:extra/slip44:0", "bitcoin")).toEqual({ kind: "unknown" });
    expect(matchCaip19Id("arkade:bitcoin/slip44:0/extra", "bitcoin")).toEqual({ kind: "unknown" });
  });

  it("rejects a coin type that is not BTC on a BTC-only rail", () => {
    expect(matchCaip19Id("arkade:bitcoin/slip44:60", "bitcoin")).toEqual({ kind: "unknown" });
    expect(matchCaip19Id("arkade:mutinynet/slip44:0", "mutinynet")).toEqual({ kind: "unknown" });
  });
});

describe("advertisedRailOptions", () => {
  it("omits caip19Id when the network is unknown", () => {
    for (const option of advertisedRailOptions(ADDRESS, CAPS)) {
      expect(option.caip19Id).toBeUndefined();
    }
  });

  it("carries one alongside every option once the network is known", () => {
    const options = advertisedRailOptions(ADDRESS, { ...CAPS, network: "mutinynet" });
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(option.caip19Id).toBe(caip19Id(option.type as "arkade", "mutinynet"));
      // `id` is untouched, which is what keeps an installed payer working.
      expect(option.id).toBe(option.type);
    }
  });
});

describe("resolvePaymentOption", () => {
  it("resolves a CAIP-19 id to the same destination as the bare name", () => {
    const bare = resolvePaymentOption("arkade", ADDRESS);
    const caip = resolvePaymentOption("arkade:mutinynet/slip44:1", ADDRESS, "mutinynet");
    expect(caip).toEqual(bare);
    expect(caip).toMatchObject({ kind: "destination", paymentDestination: ADDRESS.arkadeAddress });
  });

  it("still accepts the bare name with a network configured", () => {
    expect(resolvePaymentOption("onchain", ADDRESS, "mutinynet"))
      .toMatchObject({ kind: "destination", paymentOption: "onchain" });
  });

  it("names the network in the error when a payer is pointed at the wrong one", () => {
    const result = resolvePaymentOption("arkade:bitcoin/slip44:0", ADDRESS, "mutinynet");
    expect(result).toMatchObject({ kind: "error" });
    expect((result as { reason: string }).reason).toContain("mutinynet");
    expect((result as { reason: string }).reason).toContain("bitcoin");
  });

  it("refuses a CAIP-19 id when the server does not know its own network", () => {
    expect(resolvePaymentOption("arkade:mutinynet/slip44:1", ADDRESS)).toMatchObject({ kind: "error" });
  });

  it("maps the bolt11 namespace onto the lightning flow", () => {
    expect(resolvePaymentOption("bolt11:mutinynet/slip44:1", ADDRESS, "mutinynet")).toEqual({ kind: "lightning" });
  });
});
