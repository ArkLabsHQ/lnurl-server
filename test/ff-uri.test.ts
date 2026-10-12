import { describe, it, expect } from "vitest";
import { formatUnits, tokenPaymentUri } from "../src/rails/fixedfloat/uri.js";

const EVM_TO = "0x1111111111111111111111111111111111111111";
const SOLANA_TO = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const TRON_TO = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";

describe("token payment URIs", () => {
  it("builds an EIP-681 transfer URI with the contract, chain id, recipient and uint256", () => {
    expect(tokenPaymentUri("eip155:42161/erc20:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", EVM_TO, "8578000", 6))
      .toBe(`ethereum:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9@42161/transfer?address=${EVM_TO}&uint256=8578000`);
  });

  it("builds a Solana Pay URI with the amount in user units, not base units", () => {
    expect(tokenPaymentUri("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", SOLANA_TO, "8578000", 6))
      .toBe(`solana:${SOLANA_TO}?amount=8.578&spl-token=Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`);
  });

  it("returns undefined for tron, which has no builder in the consumers", () => {
    expect(tokenPaymentUri("tron:0x2b6653dc/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", TRON_TO, "8578000", 6)).toBeUndefined();
  });

  // Verbatim from the BTCPay plugin's TokenNamespacesTests.cs and TokenAmountTests.cs at 9b41b56.
  it("matches the BTCPay plugin's fixed vectors", () => {
    expect(tokenPaymentUri("eip155:42161/erc20:0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", EVM_TO, "63360000", 6))
      .toBe("ethereum:0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9@42161/transfer?address=0x1111111111111111111111111111111111111111&uint256=63360000");
    expect(tokenPaymentUri("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", SOLANA_TO, "63360000", 6))
      .toBe("solana:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM?amount=63.36&spl-token=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    expect(tokenPaymentUri("tron:0xcd8690dc/trc20:TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf", TRON_TO, "63360000", 6)).toBeUndefined();
    expect(tokenPaymentUri("eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", EVM_TO, "5", 6))
      .toBe("ethereum:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913@8453/transfer?address=0x1111111111111111111111111111111111111111&uint256=5");
    for (const [baseUnits, decimals, expected] of [
      ["63360000", 6, "63.36"], ["1", 6, "0.000001"], ["1000000", 6, "1"], ["0012", 0, "12"],
      ["123456789012345678901234567890", 18, "123456789012.34567890123456789"],
    ] as const) {
      expect(formatUnits(baseUnits, decimals)).toBe(expected);
    }
  });
});
