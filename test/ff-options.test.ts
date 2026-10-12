import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { advertisedRailOptions, describeServerRails, effectiveRails, type Bounds, type FfRailCaps, type ServerRailCaps } from "../src/rails.js";
import { withTokenUnits } from "../src/rails/fixedfloat/options.js";
import { FIXEDFLOAT } from "../src/rails/fixedfloat/provider.js";
import { FfBudget, ffClient } from "../src/rails/fixedfloat/client.js";
import { FfOrderStore } from "../src/ff-order-store.js";
import type { FfRail } from "../src/rails/fixedfloat/rates.js";
import { createServer } from "../src/http/server.js";
import { openDb } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories } from "../src/db/repositories/index.js";
import { AddressService } from "../src/services/addresses.js";
import type { OfflineSwapCreator } from "../src/services/offline-swaps.js";

const BASE: Bounds = { min: 1_000, max: 100_000_000 };
const FULL: ServerRailCaps = { offlineSwapCreator: true, discoveryReady: true, arkServerUrl: "https://ark.invalid", covenantDestinations: true };
const IDENTITY = { arkadeAddress: "ark1xyz", claimPublicKey: "02" + "ab".repeat(32), disabledRails: [] as string[] };

const RAILS: FfRail[] = [
  { optionId: "ff-usdtarbitrum", ffCode: "USDTARBITRUM", asset: "eip155:42161/erc20:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", unit: "USDT", decimals: 6, minSat: 2_844, maxSat: 17_819_126 },
  { optionId: "ff-usdcsol", ffCode: "USDCSOL", asset: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", unit: "USDC", decimals: 6, minSat: 2_940, maxSat: 17_819_131 },
  { optionId: "ff-usdttrc", ffCode: "USDTTRC", asset: "tron:0x2b6653dc/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", unit: "USDT", decimals: 6, minSat: 11_996, maxSat: 17_819_507 },
];
const READY: FfRailCaps = { provider: "FixedFloat", ready: true, rails: RAILS };
const CAPS: ServerRailCaps = { ...FULL, fixedFloat: READY };

const ff = (address: typeof IDENTITY & { boardingAddress?: string }, caps: ServerRailCaps = CAPS, base: Bounds = BASE) =>
  advertisedRailOptions(address, caps, base).filter((o) => o.id.startsWith("ff-"));

describe("FixedFloat paymentOptions", () => {
  it("advertises one option per rail with type set to the asset's CAIP-2 namespace", () => {
    expect(ff(IDENTITY).map((o) => [o.id, o.type, o.asset, o.unit])).toEqual(RAILS.map((r) => [r.optionId, r.asset.split(":")[0], r.asset, r.unit]));
  });

  it("states verifiable: true on every option", () => {
    for (const option of ff(IDENTITY)) expect(option.verifiable).toBe(true);
  });

  it('carries provider: "FixedFloat"', () => {
    for (const option of ff(IDENTITY)) expect(option.provider).toBe("FixedFloat");
  });

  it("intersects FF bounds with the corridor and server bounds", () => {
    expect(ff(IDENTITY)[0]).toMatchObject({ minSendable: 2_844_000, maxSendable: 100_000_000 });
    const corridor: ServerRailCaps = { ...CAPS, limits: { "offline-swap": { minSendable: 5_000_000, maxSendable: 50_000_000 } } };
    expect(ff(IDENTITY, corridor)[0]).toMatchObject({ minSendable: 5_000_000, maxSendable: 50_000_000 });
    expect(ff(IDENTITY, corridor, { min: 1_000, max: 9_999_500 })[0]).toMatchObject({ minSendable: 5_000_000, maxSendable: 9_999_000 });
  });

  it("omits an option whose intersected bounds invert", () => {
    const narrow: ServerRailCaps = { ...CAPS, limits: { "offline-swap": { maxSendable: 5_000_000 } } };
    expect(ff(IDENTITY, narrow).map((o) => o.id)).toEqual(["ff-usdtarbitrum", "ff-usdcsol"]);
  });

  it("emits available: false when the rates snapshot is stale", () => {
    const stale: ServerRailCaps = { ...FULL, fixedFloat: { ...READY, ready: false, reason: "FixedFloat rates are stale" } };
    expect(ff(IDENTITY, stale).map((o) => [o.id, o.available])).toEqual(RAILS.map((r) => [r.optionId, false]));
    expect(ff(IDENTITY, { ...CAPS, discoveryReady: false }).every((o) => o.available === false)).toBe(true);
  });

  it("omits every option when the address disables the fixedfloat rail", () => {
    expect(ff({ ...IDENTITY, disabledRails: ["fixedfloat"] })).toEqual([]);
  });

  it("offers nothing to an address with no Arkade identity, which the corridor would pay", () => {
    expect(advertisedRailOptions({ arkadeAddress: null, claimPublicKey: null, disabledRails: [] }, CAPS, BASE)).toEqual([]);
  });

  it("leaves the lightning, arkade and onchain options byte-identical", () => {
    const addresses = [
      IDENTITY,
      { ...IDENTITY, boardingAddress: "tb1qboarding" },
      { ...IDENTITY, disabledRails: ["covenant"] },
      { ...IDENTITY, disabledRails: ["interactive-lightning", "offline-swap"] },
    ];
    for (const address of addresses) {
      const withFf = advertisedRailOptions(address, CAPS, BASE).filter((o) => !o.id.startsWith("ff-"));
      expect(JSON.stringify(withFf)).toBe(JSON.stringify(advertisedRailOptions(address, FULL, BASE)));
    }
  });

  it("still emits paymentOptions for the token rails when arkade itself is disabled", () => {
    const ids = advertisedRailOptions({ ...IDENTITY, disabledRails: ["arkade"] }, CAPS, BASE).map((o) => o.id);
    expect(ids).toEqual(["lightning", "ff-usdtarbitrum", "ff-usdcsol", "ff-usdttrc"]);
  });

  it("names the unit code and emits a matching top-level units entry", () => {
    const { units } = withTokenUnits(ff(IDENTITY), []);
    expect(units).toEqual([{ code: "USDT", decimals: 6, name: "Tether USD" }, { code: "USDC", decimals: 6, name: "USD Coin" }]);
  });

  it("drops a token option whose unit code another unit source defines with other decimals", () => {
    const { options, units } = withTokenUnits(ff(IDENTITY), [{ code: "USDT", decimals: 2 }]);
    expect(options.map((o) => o.id)).toEqual(["ff-usdcsol"]);
    expect(units).toEqual([{ code: "USDT", decimals: 2 }, { code: "USDC", decimals: 6, name: "USD Coin" }]);
  });
});

describe("the fixedfloat rail state", () => {
  it("reports configured, ready and why not, per server and per address", () => {
    const row = (caps: ServerRailCaps) => describeServerRails(caps).find((s) => s.id === "fixedfloat");
    expect(row(FULL)).toMatchObject({ configured: false, ready: false });
    expect(row(FULL)?.reason).toMatch(/FIXEDFLOAT_API_KEY/);
    expect(row(CAPS)).toMatchObject({ configured: true, ready: true, label: "Token deposits (FixedFloat)" });
    expect(row({ ...FULL, fixedFloat: { ...READY, ready: false, reason: "FixedFloat rates are stale" } })?.reason).toMatch(/stale/);
    expect(row({ ...CAPS, discoveryReady: false, discoveryReason: "no cards" })).toMatchObject({ ready: false });

    const state = (address: typeof IDENTITY, caps = CAPS) => effectiveRails(address, caps).find((s) => s.id === "fixedfloat");
    expect(state(IDENTITY)).toMatchObject({ enabled: true, applicable: true, available: true });
    expect(state({ ...IDENTITY, disabledRails: ["fixedfloat"] })).toMatchObject({ enabled: false, available: false, reason: "disabled for this address" });
    expect(state(IDENTITY, FULL)).toMatchObject({ available: false });
  });
});

describe("payRequest units", () => {
  const servers: http.Server[] = [];
  afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }))); });

  it("advertises the token units its options name", async () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const repos = createRepositories(db);
    const domainId = repos.domains.create({ domain: "domain.com", allocationModes: ["self"] }).id;
    const address = repos.addresses.create({ domainId, username: "alice", status: "active", sessionId: "s-alice" });
    repos.addresses.setOfflineReceive(address.id, IDENTITY.arkadeAddress, IDENTITY.claimPublicKey);
    const creator = { create: async () => { throw new Error("unused"); }, isSettled: async () => false } as OfflineSwapCreator;
    const server = http.createServer(createServer(
      { port: 0, baseUrl: "http://domain.com", minSendable: 1_000, maxSendable: 100_000_000 },
      { repos, addressService: new AddressService(repos, randomBytes(32)), offlineSwapCreator: creator,
        fixedFloat: {
          provider: FIXEDFLOAT, rates: { snapshot: () => ({ rails: RAILS, ready: true }) },
          client: ffClient({ transport: { call: async () => { throw new Error("unused"); } }, budget: new FfBudget() }),
          orders: new FfOrderStore(db, 86_400_000), settleMarginSeconds: 600, minPayWindowSeconds: 300, maxOpenOrders: 20, maxOpenOrdersPerAddress: 2, ordersPerIp: 2, ipWindowSeconds: 600,
        } },
    ));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const body = await new Promise<any>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/.well-known/lnurlp/alice`, { headers: { Host: "domain.com" } }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(JSON.parse(d)));
      }).on("error", reject);
    });
    expect(body.paymentOptions.map((o: { id: string }) => o.id)).toEqual(["lightning", "arkade", "ff-usdtarbitrum", "ff-usdcsol", "ff-usdttrc"]);
    expect(body.units).toEqual([{ code: "USDT", decimals: 6, name: "Tether USD" }, { code: "USDC", decimals: 6, name: "USD Coin" }]);
    db.close();
  });
});
