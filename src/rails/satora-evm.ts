import { createPublicClient, fallback, http, type Chain, type PublicClient, type Transport } from "viem";
import { arbitrum, avalanche, base, hyperEvm, ink, linea, mainnet, monad, optimism, polygon, sei, sonic, unichain, worldchain, xdc } from "viem/chains";

const chains = new Map([
  mainnet, polygon, arbitrum, avalanche, optimism, base, unichain, linea, sonic,
  worldchain, monad, sei, xdc, hyperEvm, ink,
].map((chain): [string, Chain] => [String(chain.id), chain]));
let rpcUrls: Readonly<Record<string, string>> = {};

export function configureSatoraEvmRpc(urls: Readonly<Record<string, string>> = {}): void {
  rpcUrls = urls;
}

export function hasSatoraEvmRpc(chain: string): boolean {
  return chain !== "50" || rpcUrls[chain] !== undefined;
}

export function satoraEvmChain(chain: string): Chain {
  const supported = chains.get(chain);
  if (!supported) throw new Error("Unsupported Satora EVM network");
  return supported;
}

export function satoraEvmTransport(chain: string): Transport {
  const options = { retryCount: 0, timeout: 8_000 };
  if (rpcUrls[chain]) return http(rpcUrls[chain], options);
  return chain === "1"
    ? fallback([http("https://ethereum-rpc.publicnode.com", options), http("https://eth.drpc.org", options)], { retryCount: 0 })
    : http(undefined, options);
}

export function satoraEvmClient(chain: string): PublicClient<Transport, Chain> {
  return createPublicClient({ chain: satoraEvmChain(chain), transport: satoraEvmTransport(chain) });
}
