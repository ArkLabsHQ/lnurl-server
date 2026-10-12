import { describe, it, expect } from "vitest";
import { tokenOptions } from "../src/token-options.js";
import type { PayRequest } from "../src/types.js";

const ARB_USDT = "eip155:42161/erc20:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9";
const SOL_USDC = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TRON_USDT = "tron:0x2b6653dc/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const UNITS = [{ code: "USDT", decimals: 6, name: "Tether USD" }, { code: "USDC", decimals: 6, name: "USD Coin" }];

const payRequest = (paymentOptions: unknown[], units: unknown[] = UNITS) =>
  ({ paymentOptions, units }) as unknown as Pick<PayRequest, "paymentOptions" | "units">;

describe("tokenOptions", () => {
  it("parses asset, unit and provider off a payment option", () => {
    const [option] = tokenOptions(payRequest([
      { id: "lightning", type: "lightning" },
      { id: "ff-usdtarbitrum", type: "eip155", asset: ARB_USDT, unit: "USDT", provider: "FixedFloat", verifiable: true, minSendable: 2_844_000, maxSendable: 100_000_000 },
    ]));
    expect(option).toEqual({
      id: "ff-usdtarbitrum",
      asset: { id: ARB_USDT, chainId: "eip155:42161", namespace: "eip155", chainReference: "42161", assetNamespace: "erc20", reference: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9" },
      unit: { code: "USDT", decimals: 6, name: "Tether USD" },
      provider: "FixedFloat",
      available: true,
      verifiable: true,
      minSendable: 2_844_000,
      maxSendable: 100_000_000,
    });
  });

  it("parses solana and tron tokens, and reads available: false", () => {
    const options = tokenOptions(payRequest([
      { id: "ff-usdcsol", type: "solana", asset: SOL_USDC, unit: "USDC" },
      { id: "ff-usdttrc", type: "tron", asset: TRON_USDT, unit: "usdt", available: false },
    ]));
    expect(options.map((o) => [o.id, o.asset.namespace, o.unit.code, o.available])).toEqual([["ff-usdcsol", "solana", "USDC", true], ["ff-usdttrc", "tron", "USDT", false]]);
  });

  it("tokenOptions drops an option whose type does not match its asset namespace", () => {
    expect(tokenOptions(payRequest([{ id: "x", type: "solana", asset: ARB_USDT, unit: "USDT" }]))).toEqual([]);
  });

  it("tokenOptions drops an option with an unparseable CAIP-19 asset", () => {
    for (const asset of ["eip155:42161", "eip155:42161/erc20", "EIP155:42161/erc20:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", 7]) {
      expect(tokenOptions(payRequest([{ id: "x", type: "eip155", asset, unit: "USDT" }])), String(asset)).toEqual([]);
    }
  });

  it("tokenOptions drops a token its namespace cannot pay", () => {
    for (const asset of [
      "eip155:42161/erc20:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb",
      "eip155:42161/slip44:60",
      "eip155:0x2a/erc20:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9",
      "tron:0x2b6653dc/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u",
      "cosmos:cosmoshub-4/slip44:118",
    ]) {
      expect(tokenOptions(payRequest([{ id: "x", type: asset.split(":")[0], asset, unit: "USDT" }])), asset).toEqual([]);
    }
  });

  it("tokenOptions drops both options sharing one id", () => {
    expect(tokenOptions(payRequest([
      { id: "same", type: "eip155", asset: ARB_USDT, unit: "USDT" },
      { id: "same", type: "solana", asset: SOL_USDC, unit: "USDC" },
      { id: "other", type: "tron", asset: TRON_USDT, unit: "USDT" },
    ])).map((o) => o.id)).toEqual(["other"]);
  });

  it("tokenOptions drops an option whose unit is absent from units[]", () => {
    expect(tokenOptions(payRequest([{ id: "x", type: "eip155", asset: ARB_USDT, unit: "DAI" }]))).toEqual([]);
    expect(tokenOptions(payRequest([{ id: "x", type: "eip155", asset: ARB_USDT }]))).toEqual([]);
    expect(tokenOptions(payRequest([{ id: "x", type: "eip155", asset: ARB_USDT, unit: "USDT" }], [{ code: "USDT", decimals: 37 }]))).toEqual([]);
  });

  it("tokenOptions accepts a chain within a supported namespace that the client has never seen", () => {
    const asset = "eip155:999999/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    expect(tokenOptions(payRequest([{ id: "x", type: "eip155", asset, unit: "USDC" }])).map((o) => o.asset.chainId)).toEqual(["eip155:999999"]);
  });
});
