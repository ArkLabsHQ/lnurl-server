import { describe, it, expect } from "vitest";
import { FF_ASSETS, FF_UNITS, ffAssetId, isValidAddress } from "../src/rails/fixedfloat/catalogue.js";
import { BTCPAY_CHAINS, CAIP19 } from "./fixtures/btcpay-chains.js";

describe("FixedFloat asset catalogue", () => {
  it("builds eip155 erc20 ids from the live contract address", () => {
    const id = ffAssetId(FF_ASSETS.USDTARBITRUM!, "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9");
    expect(id).toBe("eip155:42161/erc20:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9");
    expect(id).toMatch(CAIP19);
  });

  it("builds solana token and tron trc20 ids", () => {
    expect(ffAssetId(FF_ASSETS.USDTSOL!, "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"))
      .toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
    expect(ffAssetId(FF_ASSETS.USDTTRC!, "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t")).toBe("tron:0x2b6653dc/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");
  });

  it("refuses a contract that is not an address of its namespace", () => {
    expect(ffAssetId(FF_ASSETS.USDTARBITRUM!, "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t")).toBeUndefined();
    expect(ffAssetId(FF_ASSETS.USDTSOL!, "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9")).toBeUndefined();
    // Right alphabet and length, wrong checksum.
    expect(ffAssetId(FF_ASSETS.USDTTRC!, "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u")).toBeUndefined();
    expect(isValidAddress("eip155", "0x" + "ab".repeat(20))).toBe(true);
    expect(isValidAddress("eip155", "0x" + "ab".repeat(19))).toBe(false);
  });

  it("every FF_ASSETS unit resolves to an FF_UNITS entry with matching decimals", () => {
    for (const [code, asset] of Object.entries(FF_ASSETS)) {
      const unit = FF_UNITS[asset.unit];
      expect(unit, code).toBeDefined();
      expect(unit.decimals, code).toBe(asset.decimals);
    }
  });

  it("no FF_ASSETS entry names a BSC chain", () => {
    expect(Object.values(FF_ASSETS).map((a) => a.chain)).not.toContain("eip155:56");
  });

  it("every FF_ASSETS chain reference is one BTCPay ChainDirectory already labels", () => {
    for (const [code, asset] of Object.entries(FF_ASSETS)) expect(BTCPAY_CHAINS, code).toContain(asset.chain);
  });
});
