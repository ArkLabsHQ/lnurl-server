export interface SatoraSource {
  id: string;
  type: "eip155" | "solana";
  chain: string;
  token: string;
  asset: string;
  unit: "USDC" | "USDT" | "EURC" | "USAT" | "USDT0" | "EURE";
  decimals: number;
  mode: "direct" | "cctp";
  gas: "provider" | "native";
}

const evm = (
  chain: string,
  name: string,
  unit: SatoraSource["unit"],
  token: string,
  decimals = 6,
  gas: SatoraSource["gas"] = "provider",
  mode: SatoraSource["mode"] = "direct",
): SatoraSource => ({
  id: `satora-${unit.toLowerCase()}${name}`,
  type: "eip155",
  chain,
  token,
  asset: `eip155:${chain}/erc20:${token}`,
  unit,
  decimals,
  mode,
  gas,
});

const cctp = (chain: string, name: string, token: string): SatoraSource =>
  evm(chain, name, "USDC", token, 6, "native", "cctp");

export const SATORA_SOURCES: readonly SatoraSource[] = [
  evm("137", "polygon", "USDC", "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"),
  evm("137", "polygon", "USDT0", "0xc2132d05d31c914a87c6611c10748aeb04b58e8f"),
  evm("42161", "arbitrum", "USDC", "0xaf88d065e77c8cc2239327c5edb3a432268e5831"),
  evm("42161", "arbitrum", "USDT0", "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9"),
  evm("42161", "arbitrum", "EURE", "0x0c06ccf38114ddfc35e07427b9424adcca9f44f8", 18),
  evm("1", "ethereum", "USDC", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"),
  evm("1", "ethereum", "USDT", "0xdac17f958d2ee523a2206206994597c13d831ec7", 6, "native"),
  evm("1", "ethereum", "EURC", "0x1abaea1f7c830bd89acc67ec4af516284b1bc33c"),
  evm("1", "ethereum", "USAT", "0x07041776f5007aca2a54844f50503a18a72a8b68"),
  cctp("43114", "avalanche", "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e"),
  cctp("10", "optimism", "0x0b2c639c533813f4aa9d7837caf62653d097ff85"),
  cctp("8453", "base", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"),
  cctp("130", "unichain", "0x078d782b760474a361dda0af3839290b0ef57ad6"),
  cctp("59144", "linea", "0x176211869ca2b568f2a7d4ee941e073a821ee1ff"),
  cctp("146", "sonic", "0x29219dd400f2bf60e5a23d13be72b486d4038894"),
  cctp("480", "worldchain", "0x79a02482a880bce3f13e09da970dc34db4cd24d1"),
  cctp("143", "monad", "0x754704bc059f8c67012fed69bc8a327a5aafb603"),
  cctp("1329", "sei", "0xe15fc38f6d8c56af07bbcbe3baf5708a2bf42392"),
  cctp("50", "xdc", "0xfa2958cb79b0491cc627c1557f441ef849ca8eb1"),
  cctp("999", "hyperevm", "0xb88339cb7199b77e23db6e890353e22632ba630f"),
  cctp("57073", "ink", "0x2d270e6886d130d724215a266106e6832161eaed"),
  {
    id: "satora-usdcsolana", type: "solana", chain: "Solana", mode: "cctp", gas: "native",
    token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", unit: "USDC", decimals: 6,
    asset: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
];

const sources = new Map(SATORA_SOURCES.map((source) => [source.id, source]));

export function satoraSource(id: string): SatoraSource | undefined {
  return sources.get(id);
}
