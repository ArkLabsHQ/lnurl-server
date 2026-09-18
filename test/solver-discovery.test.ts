import { describe, expect, it } from "vitest";
import { DiscoveryService } from "../src/solver-discovery.js";
import { legacyAssetSolverCard, legacyBtcSolverCard, registryIndex, solverCard } from "./fixtures/solver-cards.js";

const registryUrl = "https://registry.test/bitcoin.json";
// x-only; the covenant commits to an emulator key, so selection requires one.
const EMULATOR = new Uint8Array(32).fill(7);

class CardStore {
  rows: Array<{ id: number; label: string; network: string; cardJson: string; enabled: boolean; createdAt: number; updatedAt: number }> = [];
  listEnabled(network: string) { return this.rows.filter((row) => row.network === network); }
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

describe("DiscoveryService", () => {
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
