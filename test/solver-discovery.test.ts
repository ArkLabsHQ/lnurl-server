import { createServer, type AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { TransportCardFetcher } from "@arkade-os/solver-discovery";
import { DiscoveryService } from "../src/services/solver-discovery.js";
import { legacyAssetSolverCard, legacyBtcSolverCard, nostrCard, nostrPointer, nostrSolver, registryIndex, solverCard } from "./fixtures/solver-cards.js";

const registryUrl = "https://registry.test/bitcoin.json";
// x-only; the covenant commits to an emulator key, so selection requires one.
const EMULATOR = new Uint8Array(32).fill(7);
const twentyDaysLater = () => 1_000_000 + 20 * 86_400_000;

class CardStore {
  rows: Array<{ id: number; label: string; network: string; cardJson: string; enabled: boolean; createdAt: number; updatedAt: number }> = [];
  listEnabled(network: string) { return this.rows.filter((row) => row.network === network); }
  replace(id: number, input: { label: string; network: string; cardJson: string }) {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row) Object.assign(row, input, { updatedAt: row.updatedAt + 1 });
    return row;
  }
}

class CacheStore {
  row?: { url: string; network: string; body: string; fetchedAt: number };
  get(url: string, network: string) { return this.row?.url === url && this.row.network === network ? this.row : undefined; }
  put(row: { url: string; network: string; body: string; fetchedAt: number }) { this.row = row; }
}

const response = (body: unknown, status = 200) => Promise.resolve({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

const pointerIndex = (generatedAt: number) => ({ ...registryIndex(legacyBtcSolverCard("registry", 30), generatedAt), solvers: [nostrSolver()] });

const publishing = (createdAt: number, asked: unknown[][] = []): TransportCardFetcher => ({
  async fetch(...args) {
    asked.push(args);
    return [{ pubkey: nostrSolver().discovery_pubkey, createdAt, card: nostrCard() }];
  },
});

describe("DiscoveryService", () => {
  it("matches receive-side limits when net is below a solver's payer-side minimum", async () => {
    const service = new DiscoveryService({ network: "bitcoin", registryUrls: [registryUrl], cardStore: new CardStore(), cacheStore: new CacheStore(), transportCards: null, fetchImpl: async (url) => response(url === registryUrl ? registryIndex(solverCard("registry", 30), Math.floor(Date.now() / 1000)) : solverCard("registry", 30)) });
    await service.refresh();
    expect(service.selectLightningReceive(999, EMULATOR)).toEqual([]);
    expect(service.selectLightningReceive(999, EMULATOR, "to").map(c => c.name)).toEqual(["registry"]);
    expect(service.selectLightningReceive(1000001, EMULATOR, "to")).toEqual([]);
  });

  it("atomically merges registry, database, and startup-file cards in fee order", async () => {
    const cards = new CardStore();
    cards.rows.push({
      id: 1,
      label: "db",
      network: "bitcoin",
      cardJson: JSON.stringify(solverCard("cheap", 10)),
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    });
    const service = new DiscoveryService({
      network: "bitcoin",
      registryUrls: [registryUrl],
      cardsFile: "cards.json",
      cardStore: cards,
      cacheStore: new CacheStore(),
      readFile: async () => JSON.stringify([solverCard("backup", 20)]),
      fetchImpl: async () => response(registryIndex(solverCard("registry", 30), 1_000)),
      transportCards: null,
      now: () => 1_000_000,
      refreshIntervalMs: 0,
    });

    await service.start();
    expect(service.selectLightningReceive(10_000, EMULATOR).map((candidate) => candidate.name))
      .toEqual(["cheap", "backup", "registry"]);
    expect(service.status()).toMatchObject({ ready: true, candidateCount: 3, generation: 1 });
    service.stop();
  });

  it("selects a corridor card published in the registry's legacy short-id form", async () => {
    const service = new DiscoveryService({
      network: "bitcoin",
      registryUrls: [registryUrl],
      cardStore: new CardStore(),
      cacheStore: new CacheStore(),
      fetchImpl: async () => response(registryIndex(legacyBtcSolverCard("registry", 30), 1_000)),
      now: () => 1_000_000,
      refreshIntervalMs: 0,
    });

    await service.start();
    expect(service.selectLightningReceive(10_000, EMULATOR).map((candidate) => candidate.name)).toEqual(["registry"]);
    // The payer's side caps at 25_000 sats on this card.
    expect(service.selectLightningReceive(25_001, EMULATOR)).toEqual([]);
    // Below the payer-side floor.
    expect(service.selectLightningReceive(999, EMULATOR)).toEqual([]);
    service.stop();
  });

  // The payer pays the quote leg, so `max_quote_amount` binds: the live mutinynet
  // card advertises base 1000..50000 yet refuses anything over 25000.
  it("reports the payer-side range of the registry's corridor card", async () => {
    const service = new DiscoveryService({
      network: "bitcoin",
      registryUrls: [registryUrl],
      cardStore: new CardStore(),
      cacheStore: new CacheStore(),
      fetchImpl: async () => response(registryIndex(legacyBtcSolverCard("registry", 30), 1_000)),
      now: () => 1_000_000,
      refreshIntervalMs: 0,
    });

    await service.start();
    expect(service.status().receiveBounds).toEqual({ minSat: 1000, maxSat: 25_000 });
    service.stop();
  });

  it("spans the widest range any card can serve", async () => {
    const cards = new CardStore();
    cards.rows.push({
      id: 1,
      label: "db",
      network: "bitcoin",
      cardJson: JSON.stringify(solverCard("cheap", 10, "bitcoin", { min: "5000", max: "200000" })),
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    });
    const service = new DiscoveryService({
      network: "bitcoin",
      registryUrls: [registryUrl],
      cardStore: cards,
      cacheStore: new CacheStore(),
      fetchImpl: async () => response(registryIndex(legacyBtcSolverCard("registry", 30), 1_000)),
      transportCards: null,
      now: () => 1_000_000,
      refreshIntervalMs: 0,
    });

    await service.start();
    expect(service.status().receiveBounds).toEqual({ minSat: 1000, maxSat: 200_000 });
    service.stop();
  });

  it("reports no range at all when nothing usable was discovered", async () => {
    const service = new DiscoveryService({
      network: "bitcoin",
      registryUrls: [registryUrl],
      cardStore: new CardStore(),
      cacheStore: new CacheStore(),
      fetchImpl: async () => response(registryIndex(legacyAssetSolverCard("registry", 30), 1_000)),
      now: () => 1_000_000,
      refreshIntervalMs: 0,
    });

    // Corridors match but the legs are an asset, which the rail refuses anyway.
    await service.start();
    expect(service.status().receiveBounds).toBeUndefined();
    service.stop();
  });

  it("follows the published network registry when registry URLs are omitted", async () => {
    const requested: string[] = [];
    const service = new DiscoveryService({
      network: "bitcoin",
      registryUrls: undefined,
      cardStore: new CardStore(),
      cacheStore: new CacheStore(),
      fetchImpl: async (url) => {
        requested.push(url);
        return response(registryIndex(solverCard("registry", 30), 1_000));
      },
      now: () => 1_000_000,
      refreshIntervalMs: 0,
    });

    await service.start();
    expect(requested).toEqual(["https://arkade-os.github.io/solver-registry/bitcoin.json"]);
    expect(service.status()).toMatchObject({ ready: true, candidateCount: 1 });
    service.stop();
  });

  it("starts without candidates so the interactive LNURL relay remains available", async () => {
    const service = new DiscoveryService({
      network: "bitcoin",
      registryUrls: [registryUrl],
      cardStore: new CardStore(),
      cacheStore: new CacheStore(),
      fetchImpl: async () => response({
        version: 0,
        network: "bitcoin",
        generated_at: 1_000,
        commit: "a".repeat(40),
        markets: [],
      }),
      refreshIntervalMs: 0,
    });

    await expect(service.start()).resolves.toBeUndefined();
    expect(service.status()).toMatchObject({ ready: false, candidateCount: 0, reason: "no usable lightning-receive solver cards" });
    service.stop();
  });

  it("refuses an asset receive even though its corridors are the right ones", async () => {
    const service = new DiscoveryService({
      network: "bitcoin",
      registryUrls: [registryUrl],
      cardStore: new CardStore(),
      cacheStore: new CacheStore(),
      fetchImpl: async () => response(registryIndex(legacyAssetSolverCard("registry", 30), 1_000)),
      now: () => 1_000_000,
      refreshIntervalMs: 0,
    });

    await service.start();
    expect(service.selectLightningReceive(10_000, EMULATOR)).toEqual([]);
    service.stop();
  });

  it("uses a fresh cached index after registry failure and refuses it after seven days", async () => {
    const cache = new CacheStore();
    cache.row = {
      url: registryUrl,
      network: "bitcoin",
      body: JSON.stringify(registryIndex(solverCard("registry", 30), 1_000)),
      fetchedAt: 1_000_000,
    };
    let now = 1_060_000;
    const service = new DiscoveryService({
      network: "bitcoin",
      registryUrls: [registryUrl],
      cardStore: new CardStore(),
      cacheStore: cache,
      fetchImpl: async () => { throw new Error("offline"); },
      now: () => now,
      refreshIntervalMs: 0,
    });

    await service.start();
    expect(service.status()).toMatchObject({ ready: true, sources: [expect.objectContaining({ cache: "fresh" })] });
    service.stop();

    now = 1_000_000 + 7 * 86_400_000 + 1;
    const expired = new DiscoveryService({
      network: "bitcoin",
      registryUrls: [registryUrl],
      cardStore: new CardStore(),
      cacheStore: cache,
      fetchImpl: async () => { throw new Error("offline"); },
      now: () => now,
      refreshIntervalMs: 0,
    });
    await expired.start();
    expect(expired.status()).toMatchObject({ ready: false, candidateCount: 0 });
    expired.stop();
  });

  it("does not replace the last known-good cache with an invalid HTTP 200 body", async () => {
    const cache = new CacheStore();
    const goodBody = JSON.stringify(registryIndex(solverCard("registry", 30), 1_000));
    cache.row = { url: registryUrl, network: "bitcoin", body: goodBody, fetchedAt: 900_000 };
    const corrupt = new DiscoveryService({
      network: "bitcoin", registryUrls: [registryUrl], cardStore: new CardStore(), cacheStore: cache,
      fetchImpl: async () => response({ invalid: true }), now: () => 1_000_000, refreshIntervalMs: 0,
    });
    await corrupt.start();
    expect(corrupt.status()).toMatchObject({ ready: false, candidateCount: 0 });
    expect(cache.row?.body).toBe(goodBody);
    corrupt.stop();

    const restarted = new DiscoveryService({
      network: "bitcoin", registryUrls: [registryUrl], cardStore: new CardStore(), cacheStore: cache,
      fetchImpl: async () => { throw new Error("offline"); }, now: () => 1_000_001, refreshIntervalMs: 0,
    });
    await restarted.start();
    expect(restarted.status()).toMatchObject({ ready: true, candidateCount: 1 });
    restarted.stop();
  });

  it("falls back to the cache when a registry body is over the size limit, without reading all of it", async () => {
    const cache = new CacheStore();
    cache.row = { url: registryUrl, network: "bitcoin", body: JSON.stringify(registryIndex(solverCard("registry", 30), 1_000)), fetchedAt: 900_000 };
    const chunk = 64 * 1024;
    const total = 8 * 1024 * 1024;
    let pulled = 0;
    const oversized = () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= total) return controller.close();
        pulled += chunk;
        controller.enqueue(new Uint8Array(chunk).fill(0x20));
      },
    }));
    const service = new DiscoveryService({
      network: "bitcoin", registryUrls: [registryUrl], cardStore: new CardStore(), cacheStore: cache,
      fetchImpl: async () => oversized(), now: () => 1_000_000, refreshIntervalMs: 0,
    });

    await service.start();
    expect(service.status()).toMatchObject({ ready: true, sources: [expect.objectContaining({ cache: "fresh" })] });
    expect(pulled).toBeLessThan(total);
    service.stop();
  });

  it("refuses an oversized registry body even when cancelling its stream never settles", async () => {
    const cache = new CacheStore();
    cache.row = { url: registryUrl, network: "bitcoin", body: JSON.stringify(registryIndex(solverCard("registry", 30), 1_000)), fetchedAt: 900_000 };
    const stuck = () => new Response(new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(new Uint8Array(64 * 1024).fill(0x20)),
      cancel: () => new Promise<void>(() => {}),
    }));
    const service = new DiscoveryService({
      network: "bitcoin", registryUrls: [registryUrl], cardStore: new CardStore(), cacheStore: cache,
      fetchImpl: async () => stuck(), now: () => 1_000_000, refreshIntervalMs: 0,
    });

    await service.start();
    expect(service.status()).toMatchObject({ ready: true, sources: [expect.objectContaining({ cache: "fresh" })] });
    service.stop();
  });

  it("keeps pasted and file-pinned cards while a stale registry's copy is held out", async () => {
    const cache = new CacheStore();
    const card = legacyBtcSolverCard("registry", 30);
    const cards = new CardStore();
    cards.rows.push({
      id: 1, label: "pasted", network: "bitcoin", cardJson: JSON.stringify(legacyBtcSolverCard("cheap", 10)),
      enabled: true, createdAt: 1, updatedAt: 1,
    });
    const service = new DiscoveryService({
      network: "bitcoin", registryUrls: [registryUrl], cardsFile: "cards.json", cardStore: cards, cacheStore: cache,
      readFile: async () => JSON.stringify([card]),
      fetchImpl: async () => response(registryIndex(card, 1_000)),
      transportCards: null, now: twentyDaysLater, refreshIntervalMs: 0,
    });

    await service.start();
    expect(service.selectLightningReceive(10_000, EMULATOR).map(({ source, sourceType }) => ({ source, sourceType })))
      .toEqual([{ source: "db:1:pasted", sourceType: "local" }, { source: "file:cards.json:0", sourceType: "local" }]);
    expect(service.status()).toMatchObject({ ready: true, candidateCount: 2 });
    expect(cache.row?.url).toBe(registryUrl);
    service.stop();
  });

  it("still takes nothing from a stale registry on its own", async () => {
    const cache = new CacheStore();
    const service = new DiscoveryService({
      network: "bitcoin", registryUrls: [registryUrl], cardStore: new CardStore(), cacheStore: cache,
      fetchImpl: async () => response(registryIndex(legacyBtcSolverCard("registry", 30), 1_000)),
      now: twentyDaysLater, refreshIntervalMs: 0,
    });

    await service.start();
    expect(service.status()).toMatchObject({ ready: false, candidateCount: 0 });
    expect(service.status().warnings).toEqual([expect.stringMatching(/index is stale/), expect.stringMatching(/1 market\(s\) held out/)]);
    expect(cache.row?.url).toBe(registryUrl);
    service.stop();
  });

  it("takes a stale registry's pointer-listed solver from its fresh card, and none of the registry's snapshot", async () => {
    const cache = new CacheStore();
    const service = new DiscoveryService({
      network: "bitcoin", registryUrls: [registryUrl], cardStore: new CardStore(), cacheStore: cache,
      fetchImpl: async () => response(pointerIndex(1_000)),
      transportCards: publishing(twentyDaysLater() / 1000),
      now: twentyDaysLater, refreshIntervalMs: 0,
    });

    await service.start();
    expect(service.selectLightningReceive(10_000, EMULATOR).map(({ name, source }) => ({ name, source })))
      .toEqual([{ name: "nostr-solver", source: registryUrl }]);
    expect(service.status().warnings).toEqual([expect.stringMatching(/index is stale/), expect.stringMatching(/1 market\(s\) held out/)]);
    expect(cache.row?.url).toBe(registryUrl);
    service.stop();
  });

  it("serves a fresh registry's copy of a market a local card also pins", async () => {
    const cache = new CacheStore();
    const card = legacyBtcSolverCard("registry", 30);
    const service = new DiscoveryService({
      network: "bitcoin", registryUrls: [registryUrl], cardsFile: "cards.json", cardStore: new CardStore(), cacheStore: cache,
      readFile: async () => JSON.stringify([card]),
      fetchImpl: async () => response(registryIndex(card, 1_000)),
      transportCards: null, now: () => 1_000_000, refreshIntervalMs: 0,
    });

    await service.start();
    expect(service.selectLightningReceive(10_000, EMULATOR).map(({ source, sourceType }) => ({ source, sourceType })))
      .toEqual([{ source: registryUrl, sourceType: "registry" }]);
    expect(cache.row?.url).toBe(registryUrl);
    service.stop();
  });

  it("does not let a stale registry hide a market a fresh one also lists", async () => {
    const staleUrl = "https://stale.test/bitcoin.json";
    const card = legacyBtcSolverCard("registry", 30);
    const fetched: string[] = [];
    const service = new DiscoveryService({
      network: "bitcoin", registryUrls: [staleUrl, registryUrl], cardStore: new CardStore(), cacheStore: new CacheStore(),
      fetchImpl: async (url) => {
        fetched.push(url);
        return response(registryIndex(card, url === staleUrl ? 1_000 : 1_000 + 20 * 86_400));
      },
      now: twentyDaysLater, refreshIntervalMs: 0,
    });

    await service.start();
    expect(service.selectLightningReceive(10_000, EMULATOR).map((candidate) => candidate.source)).toEqual([registryUrl]);
    expect(fetched).toEqual([staleUrl, registryUrl]);
    service.stop();
  });

  it("keeps the previous snapshot when a refresh has no usable replacement", async () => {
    let body: unknown = registryIndex(solverCard("registry", 30), 1_000);
    const service = new DiscoveryService({
      network: "bitcoin",
      registryUrls: [registryUrl],
      cardStore: new CardStore(),
      cacheStore: new CacheStore(),
      fetchImpl: async () => response(body),
      now: () => 1_000_000,
      refreshIntervalMs: 0,
    });
    await service.start();
    body = { invalid: true };
    await service.refresh();
    expect(service.status()).toMatchObject({ ready: true, candidateCount: 1, generation: 1 });
    expect(service.selectLightningReceive(10_000, EMULATOR)[0]?.name).toBe("registry");
    service.stop();
  });

  it("immediately clears a local-only snapshot when the last pasted card is removed", async () => {
    const cards = new CardStore();
    cards.rows.push({
      id: 1,
      label: "manual",
      network: "bitcoin",
      cardJson: JSON.stringify(solverCard("cheap", 10)),
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    });
    const service = new DiscoveryService({
      network: "bitcoin",
      registryUrls: [],
      cardStore: cards,
      cacheStore: new CacheStore(),
      transportCards: null,
      refreshIntervalMs: 0,
    });

    await service.start();
    expect(service.status()).toMatchObject({ ready: true, candidateCount: 1 });
    cards.rows = [];
    await service.refresh();
    expect(service.status()).toMatchObject({ ready: false, candidateCount: 0 });
    service.stop();
  });

  it("queues a fresh snapshot when a card mutation overlaps an in-flight refresh", async () => {
    const cards = new CardStore();
    cards.rows.push({
      id: 1, label: "manual", network: "bitcoin", cardJson: JSON.stringify(solverCard("cheap", 10)),
      enabled: true, createdAt: 1, updatedAt: 1,
    });
    let calls = 0;
    let releaseFetch!: () => void;
    let markStarted!: () => void;
    const fetchBlocked = new Promise<void>((resolve) => { releaseFetch = resolve; });
    const fetchStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const empty = { ...registryIndex(solverCard("registry", 30), 1_000), markets: [] };
    const service = new DiscoveryService({
      network: "bitcoin",
      registryUrls: [registryUrl],
      cardStore: cards,
      cacheStore: new CacheStore(),
      fetchImpl: async () => {
        calls++;
        if (calls === 2) { markStarted(); await fetchBlocked; }
        return response(calls >= 3 ? empty : registryIndex(solverCard("registry", 30), 1_000));
      },
      transportCards: null,
      now: () => 1_000_000,
      refreshIntervalMs: 0,
    });

    await service.start();
    const first = service.refresh();
    await fetchStarted;
    cards.rows = [];
    const mutation = service.refresh();
    releaseFetch();
    await Promise.all([first, mutation]);
    expect(calls).toBe(3);
    expect(service.status()).toMatchObject({ ready: false, candidateCount: 0 });
    service.stop();
  });

  it("trades with a solver the registry lists by pointer, on the card it publishes over Nostr", async () => {
    const asked: unknown[][] = [];
    const service = new DiscoveryService({
      network: "bitcoin", registryUrls: [registryUrl], cardStore: new CardStore(), cacheStore: new CacheStore(),
      fetchImpl: async () => response(pointerIndex(1_000)),
      transportCards: publishing(1_000, asked),
      now: () => 1_000_000, refreshIntervalMs: 0,
    });

    await service.start();
    expect(service.selectLightningReceive(10_000, EMULATOR).find((candidate) => candidate.name === "nostr-solver"))
      .toMatchObject({ source: registryUrl, sourceType: "registry", relays: ["wss://nostr.relay.test"] });
    expect(asked).toEqual([[[nostrSolver()], "bitcoin"]]);
    service.stop();
  });

  it("resolves a pasted pointer card from the card its solver publishes", async () => {
    const cards = new CardStore();
    cards.rows.push({
      id: 1, label: "pointer", network: "bitcoin", cardJson: JSON.stringify(nostrPointer()),
      enabled: true, createdAt: 1, updatedAt: 1,
    });
    const service = new DiscoveryService({
      network: "bitcoin", registryUrls: [], cardStore: cards, cacheStore: new CacheStore(),
      transportCards: publishing(1_000), now: () => 1_000_000, refreshIntervalMs: 0,
    });

    await service.start();
    expect(service.selectLightningReceive(10_000, EMULATOR).map(({ name, source }) => ({ name, source })))
      .toEqual([{ name: "nostr-solver", source: "db:1:pointer" }]);
    // The admin API reports a pasted card active off this count.
    expect(service.status().sources).toEqual([expect.objectContaining({ source: "db:1:pointer", ok: true, marketCount: 1 })]);
    service.stop();
  });

  it("stores the card its solver publishes over a stale pasted copy, and leaves pointers and rejected cards alone", async () => {
    const cards = new CardStore();
    const row = (id: number, card: unknown) => ({
      id, label: `row${id}`, network: "bitcoin", cardJson: JSON.stringify(card), enabled: true, createdAt: 1, updatedAt: 1,
    });
    const pointer = nostrPointer();
    cards.rows.push(row(1, nostrCard(50)), row(2, pointer));
    const published = (createdAt: number): TransportCardFetcher => ({
      fetch: async () => [{ pubkey: nostrSolver().discovery_pubkey, createdAt, card: nostrCard(10) }],
    });
    const service = (createdAt: number) => new DiscoveryService({
      network: "bitcoin", registryUrls: [], cardStore: cards, cacheStore: new CacheStore(),
      transportCards: published(createdAt), now: () => 10_000_000, refreshIntervalMs: 0,
    });

    // Past MAX_CARD_AGE_SECONDS: discover() refuses it, so the stored copy must not take it either.
    await service(10_000 - 7_201).start();
    expect(cards.rows.map((r) => r.updatedAt)).toEqual([1, 1]);

    await service(10_000).start();
    expect(JSON.parse(cards.rows[0]!.cardJson).markets).toEqual(nostrCard(10).markets);
    expect(cards.rows[1]!.cardJson).toBe(JSON.stringify(pointer));

    // Same content re-sent on the heartbeat: no write.
    await service(10_000).start();
    expect(cards.rows[0]!.updatedAt).toBe(2);
  });

  it("keeps the cards it has when Nostr cannot be read, and only warns", async () => {
    const cards = new CardStore();
    cards.rows.push({
      id: 1, label: "db", network: "bitcoin", cardJson: JSON.stringify(solverCard("cheap", 10)),
      enabled: true, createdAt: 1, updatedAt: 1,
    });
    const service = new DiscoveryService({
      network: "bitcoin", registryUrls: [], cardStore: cards, cacheStore: new CacheStore(),
      transportCards: { fetch: async () => { throw new Error("every relay refused"); } },
      now: () => 1_000_000, refreshIntervalMs: 0,
    });

    await service.start();
    expect(service.selectLightningReceive(10_000, EMULATOR).map((candidate) => candidate.name)).toEqual(["cheap"]);
    expect(service.status().warnings).toEqual([expect.stringMatching(/^db:.*: transport cards: every relay refused$/)]);
    service.stop();
  });

  it("dials a pointer's private relay only on regtest, and nothing when transport cards are off", async () => {
    let connections = 0;
    const relay = createServer((socket) => { connections++; socket.destroy(); });
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
    const relayUrl = `ws://127.0.0.1:${(relay.address() as AddressInfo).port}`;
    const service = (network: "bitcoin" | "regtest", transportCards?: null) => {
      const cards = new CardStore();
      cards.rows.push({
        id: 1, label: "pointer", network, cardJson: JSON.stringify(nostrPointer(relayUrl)),
        enabled: true, createdAt: 1, updatedAt: 1,
      });
      return new DiscoveryService({
        network, registryUrls: [], cardStore: cards, cacheStore: new CacheStore(), refreshIntervalMs: 0,
        ...(transportCards === null ? { transportCards } : {}),
      });
    };

    try {
      await service("regtest", null).start();
      expect(connections).toBe(0);
      const bitcoin = service("bitcoin");
      await bitcoin.start();
      expect(connections).toBe(0);
      expect(bitcoin.status().warnings).toContain(`nostr-solver: relay ${relayUrl} refused: private host`);
      await service("regtest").start();
      expect(connections).toBeGreaterThan(0);
    } finally {
      relay.close();
    }
  });

  it("leaves out a solver whose only relay is private, except on regtest", async () => {
    const service = (network: "bitcoin" | "regtest") => {
      const card = { ...solverCard("cheap", 10, network), transports: { nostr: { relays: ["wss://10.0.0.5"] } } };
      return new DiscoveryService({
        network, registryUrls: [registryUrl], cardStore: new CardStore(), cacheStore: new CacheStore(),
        fetchImpl: async () => response(registryIndex(card, 1_000, network)),
        transportCards: null, now: () => 1_000_000, refreshIntervalMs: 0,
      });
    };

    const bitcoin = service("bitcoin");
    await bitcoin.start();
    expect(bitcoin.status().candidateCount).toBe(0);
    expect(bitcoin.status().warnings).toContain("cheap: relay wss://10.0.0.5 refused: private host");
    const regtest = service("regtest");
    await regtest.start();
    expect(regtest.status().candidateCount).toBe(1);
  });

  it("keeps a solver's public relays and drops only its private ones", async () => {
    const card = { ...solverCard("cheap", 10), transports: { nostr: { relays: ["wss://10.0.0.5", "wss://cheap.relay.test"] } } };
    const service = new DiscoveryService({
      network: "bitcoin", registryUrls: [registryUrl], cardStore: new CardStore(), cacheStore: new CacheStore(),
      fetchImpl: async () => response(registryIndex(card, 1_000)),
      transportCards: null, now: () => 1_000_000, refreshIntervalMs: 0,
    });

    await service.start();
    expect(service.selectLightningReceive(10_000, EMULATOR).map((candidate) => candidate.relays)).toEqual([["wss://cheap.relay.test"]]);
    expect(service.status().warnings).toContain("cheap: relay wss://10.0.0.5 refused: private host");
  });

  it("resolves a pointer card pinned in the card file from the card its solver publishes", async () => {
    const service = new DiscoveryService({
      network: "bitcoin", registryUrls: [], cardsFile: "cards.json", cardStore: new CardStore(), cacheStore: new CacheStore(),
      readFile: async () => JSON.stringify([nostrPointer()]),
      transportCards: publishing(1_000), now: () => 1_000_000, refreshIntervalMs: 0,
    });

    await service.start();
    expect(service.selectLightningReceive(10_000, EMULATOR).map(({ name, source }) => ({ name, source })))
      .toEqual([{ name: "nostr-solver", source: "file:cards.json:0" }]);
    service.stop();
  });

  it("fails startup when a configured card file contains an invalid card", async () => {
    const service = new DiscoveryService({
      network: "bitcoin",
      registryUrls: [],
      cardsFile: "cards.json",
      cardStore: new CardStore(),
      cacheStore: new CacheStore(),
      readFile: async () => JSON.stringify([{}]),
      refreshIntervalMs: 0,
    });
    await expect(service.start()).rejects.toThrow(/cards.json.*invalid card/i);
  });
});
