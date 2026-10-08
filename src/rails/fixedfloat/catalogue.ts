// The tokens a FixedFloat rail may advertise, keyed by FixedFloat's own currency code.
// No entry, no rail: the token's decimals are not something FixedFloat serves (its
// `precision` is quoting precision), and a wrong divisor is a wrong payment amount.
// Decimals were read on-chain on 2026-10-07 (ERC-20 decimals(), the Solana mints,
// TRC-20 decimals()). The contract is absent on purpose: ccies serves it live.

import { base58, createBase58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";

export type TokenNamespace = "eip155" | "solana" | "tron";
export type TokenUnitCode = "USDT" | "USDC";

export interface FfAsset {
  /** CAIP-2 chain id. */
  chain: string;
  /** CAIP-19 asset namespace within the chain. */
  ns: "erc20" | "token" | "trc20";
  unit: TokenUnitCode;
  decimals: number;
}

const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const TRON = "tron:0x2b6653dc";

// BSC's USDT and USDC are 18 decimals, so they cannot share the 6-decimal USDT/USDC units.
export const FF_ASSETS: Readonly<Record<string, FfAsset>> = {
  USDTARBITRUM: { chain: "eip155:42161", ns: "erc20", unit: "USDT", decimals: 6 },
  USDCARBITRUM: { chain: "eip155:42161", ns: "erc20", unit: "USDC", decimals: 6 },
  USDT: { chain: "eip155:1", ns: "erc20", unit: "USDT", decimals: 6 },
  USDCETH: { chain: "eip155:1", ns: "erc20", unit: "USDC", decimals: 6 },
  USDCBASE: { chain: "eip155:8453", ns: "erc20", unit: "USDC", decimals: 6 },
  USDCOP: { chain: "eip155:10", ns: "erc20", unit: "USDC", decimals: 6 },
  USDTMATIC: { chain: "eip155:137", ns: "erc20", unit: "USDT", decimals: 6 },
  USDCMATIC: { chain: "eip155:137", ns: "erc20", unit: "USDC", decimals: 6 },
  USDTAVAX: { chain: "eip155:43114", ns: "erc20", unit: "USDT", decimals: 6 },
  USDCAVAX: { chain: "eip155:43114", ns: "erc20", unit: "USDC", decimals: 6 },
  USDTSOL: { chain: SOLANA, ns: "token", unit: "USDT", decimals: 6 },
  USDCSOL: { chain: SOLANA, ns: "token", unit: "USDC", decimals: 6 },
  USDTTRC: { chain: TRON, ns: "trc20", unit: "USDT", decimals: 6 },
};

export const FF_UNITS: Readonly<Record<TokenUnitCode, { code: TokenUnitCode; decimals: number; name: string }>> = {
  USDT: { code: "USDT", decimals: 6, name: "Tether USD" },
  USDC: { code: "USDC", decimals: 6, name: "USD Coin" },
};

const tronCheck = createBase58check(sha256);

/** The chain's own address shape, as the consumers check it (BTCPay TokenNamespaces.cs). */
export function isValidAddress(namespace: string, address: string): boolean {
  if (namespace === "eip155") return /^0x[0-9a-fA-F]{40}$/.test(address);
  try {
    if (namespace === "solana") return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) && base58.decode(address).length === 32;
    if (namespace === "tron") {
      if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return false;
      const bytes = tronCheck.decode(address);
      return bytes.length === 21 && bytes[0] === 0x41;
    }
  } catch {
    return false;
  }
  return false;
}

export const namespaceOf = (chain: string): string => chain.slice(0, chain.indexOf(":"));

/** A transaction id in its chain's own shape, the one BTCPay links to an explorer by
 *  (ChainDirectory.cs): 0x + 64 hex on EVM, bare 64 hex on Tron, base58 on Solana. */
export function chainTxid(namespace: string, raw: string): string | undefined {
  const hex = /^(?:0x)?([0-9a-fA-F]{64})$/.exec(raw)?.[1];
  if (namespace === "eip155") return hex ? `0x${hex}` : undefined;
  if (namespace === "tron") return hex;
  if (namespace === "solana") {
    // A transaction id is its 64-byte signature; a hex string can pass the alphabet alone.
    try {
      return /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(raw) && base58.decode(raw).length === 64 ? raw : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The CAIP-19 id for a token at `contract`, or undefined when the contract is not an
 *  address of the asset's chain — a stale or garbled catalogue row, not a rail. */
export function ffAssetId(asset: FfAsset, contract: string): string | undefined {
  return isValidAddress(namespaceOf(asset.chain), contract) ? `${asset.chain}/${asset.ns}:${contract}` : undefined;
}
