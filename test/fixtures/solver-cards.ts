import type { Card, Network, NetworkIndex } from "@arkade-os/solver-discovery";

const pubkeys = {
  cheap: "11".repeat(32),
  backup: "22".repeat(32),
  registry: "33".repeat(32),
};

export function solverCard(name: keyof typeof pubkeys, feeBps: number, network: Network = "bitcoin"): Card {
  const slip = network === "bitcoin" ? "0" : "1";
  return {
    version: 0,
    name,
    discovery_pubkey: pubkeys[name],
    sig: "44".repeat(64),
    transports: { nostr: { relays: [`wss://${name}.relay.test`] } },
    markets: [{
      base_asset: { id: `arkade:${network}/slip44:${slip}`, name: "Bitcoin", ticker: "BTC", decimals: 8 },
      quote_asset: { id: `bolt11:${network}/slip44:${slip}`, name: "Bitcoin", ticker: "BTC", decimals: 8 },
      fee_bps: feeBps,
      min_base_amount: "1",
      max_base_amount: "1000000",
      min_quote_amount: "1000",
      max_quote_amount: "100000",
    }],
  };
}

export function registryIndex(card: Card, generatedAt: number, network: Network = "bitcoin"): NetworkIndex {
  return {
    version: 0,
    network,
    generated_at: generatedAt,
    commit: "a".repeat(40),
    markets: card.markets.map((market) => ({
      ...market,
      solver: card.name,
      discovery_pubkey: card.discovery_pubkey,
      transports: card.transports,
    })),
  };
}
