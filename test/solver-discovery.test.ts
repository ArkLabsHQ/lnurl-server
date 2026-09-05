import { describe, it, expect } from "vitest";
import http from "node:http";
import { discoverLightningCorridor } from "../src/solver-discovery.js";

const PUBKEY = "3f831510a6d7678d0c90d7d6fbc4057720517e2e30681ef4c87cc57aaf57e8d5";
const PUBKEY2 = "aa".repeat(32);

function card(over: Record<string, unknown> = {}) {
  return {
    pair: "BTC/lightning:BTC",
    quote_corridor: "lightning",
    fee_bps: 30,
    min_base_amount: "1000",
    max_base_amount: "50000",
    min_quote_amount: "1000",
    max_quote_amount: "25000",
    solver: "ln-solver",
    discovery_pubkey: PUBKEY,
    transports: { nostr: { relays: ["wss://nostr.arkade.sh"] } },
    ...over,
  };
}

function serveIndex(body: unknown, status = 200): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) });
    });
  });
}

describe("discoverLightningCorridor", () => {
  it("picks the lowest-fee lightning-corridor card with bounds in sats", async () => {
    const idx = await serveIndex({
      markets: [
        card({ solver: "expensive", fee_bps: 50, discovery_pubkey: PUBKEY2 }),
        card(),
        { pair: "BTC/USDT", fee_bps: 10 }, // spot market — not a corridor
      ],
    });
    try {
      const c = await discoverLightningCorridor(idx.url);
      expect(c).toEqual({
        name: "ln-solver",
        discoveryPubkey: PUBKEY,
        relays: ["wss://nostr.arkade.sh"],
        feeBps: 30,
        minSat: 1000,
        maxSat: 25000,
      });
    } finally {
      await idx.close();
    }
  });

  it("skips malformed cards (bad pubkey, no nostr relays) and returns null when none serve lightning", async () => {
    const idx = await serveIndex({
      markets: [
        card({ discovery_pubkey: "not-hex" }),
        card({ discovery_pubkey: PUBKEY2, transports: { nostr: { relays: [] } } }),
      ],
    });
    try {
      expect(await discoverLightningCorridor(idx.url)).toBeNull();
    } finally {
      await idx.close();
    }
  });

  it("throws on a non-2xx index and on a body without a markets array", async () => {
    const err500 = await serveIndex({}, 500);
    try {
      await expect(discoverLightningCorridor(err500.url)).rejects.toThrow(/HTTP 500/);
    } finally {
      await err500.close();
    }
    const noMarkets = await serveIndex({});
    try {
      await expect(discoverLightningCorridor(noMarkets.url)).rejects.toThrow(/markets/);
    } finally {
      await noMarkets.close();
    }
  });

  it("accepts ws:// (dev relays) and fails fast on a hung index fetch", async () => {
    const idx = await serveIndex({ markets: [card({ transports: { nostr: { relays: ["ws://localhost:7777"] } } })] });
    try {
      expect((await discoverLightningCorridor(idx.url))?.relays).toEqual(["ws://localhost:7777"]);
    } finally {
      await idx.close();
    }

    // A server that accepts the socket but never answers must not stall startup.
    const hanger = http.createServer(() => {});
    await new Promise<void>((r) => hanger.listen(0, "127.0.0.1", r));
    try {
      const port = (hanger.address() as { port: number }).port;
      await expect(discoverLightningCorridor(`http://127.0.0.1:${port}`, fetch, 50)).rejects.toThrow();
    } finally {
      hanger.closeAllConnections();
      await new Promise<void>((r) => hanger.close(() => r()));
    }
  });
});
