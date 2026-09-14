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

/**
 * The shape the public registry still publishes its corridor cards in: legacy
 * v0 short asset ids plus separate `*_corridor` fields, which `marketLegKey`
 * renders as `arkade:btc`/`lightning:btc` rather than the canonical CAIP-19
 * legs. Pin the live shape here so a query that only speaks CAIP-19 fails a
 * test instead of a deployment.
 */
export function legacyBtcSolverCard(name: keyof typeof pubkeys, feeBps: number): Card {
  return {
    version: 0,
    name,
    discovery_pubkey: pubkeys[name],
    sig: "44".repeat(64),
    transports: { nostr: { relays: [`wss://${name}.relay.test`] } },
    markets: [{
      pair: "BTC/lightning:BTC",
      base_asset: { id: "btc", name: "Bitcoin", ticker: "BTC", decimals: 8 },
      quote_asset: { id: "btc", name: "Bitcoin", ticker: "BTC", decimals: 8 },
      quote_corridor: "lightning",
      fee_bps: feeBps,
      min_base_amount: "1000",
      max_base_amount: "50000",
      min_quote_amount: "1000",
      max_quote_amount: "25000",
    }],
  };
}

/** Same corridors, asset legs: a receive that would deliver an Arkade asset
 *  rather than BTC, which the rail must refuse. Same underlying asset on both
 *  sides, so no `price_feed` is required. */
export function legacyAssetSolverCard(name: keyof typeof pubkeys, feeBps: number): Card {
  const assetId = "ab".repeat(34);
  return {
    version: 0,
    name,
    discovery_pubkey: pubkeys[name],
    sig: "44".repeat(64),
    transports: { nostr: { relays: [`wss://${name}.relay.test`] } },
    markets: [{
      base_asset: { id: `arkade:bitcoin/asset:${assetId}`, name: "Token", ticker: "TOK", decimals: 0 },
      quote_asset: { id: `bolt11:bitcoin/asset:${assetId}`, name: "Token", ticker: "TOK", decimals: 0 },
      fee_bps: feeBps,
      min_base_amount: "1",
      max_base_amount: "1000000",
      min_quote_amount: "1000",
      max_quote_amount: "100000",
    }],
  };
}
