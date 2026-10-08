import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "../src/http/server.js";
import { createRepositories } from "../src/db/repositories/index.js";
import { AddressService } from "../src/services/addresses.js";
import { OfflineSwapStore } from "../src/offline-swap-store.js";
import type { OfflineSwapCreator } from "../src/services/offline-swaps.js";
import { buildInvoice } from "./helpers/bolt11.js";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { assertFixedFloatNetwork, loadConfig } from "../src/config.js";
import { DbSettlementStore } from "../src/settlement-store.js";
import { createLogger } from "../src/logger.js";
import { advertisedRailOptions, describeServerRails, type ServerRailCaps } from "../src/rails.js";
import { FF_ASSETS, isValidAddress, namespaceOf } from "../src/rails/fixedfloat/catalogue.js";
import { SIM_ASSETS } from "../src/rails/fixedfloat/simulate.js";
import { startFixedFloat, type StartedFixedFloat } from "../src/rails/fixedfloat/wiring.js";
import { BTCPAY_CHAINS } from "./fixtures/btcpay-chains.js";
import { pollUntil } from "./e2e/support/regtest.js";

const SIMULATE = {
  PORT: "3000", BASE_URL: "http://localhost:3000", ARK_SERVER_URL: "https://ark.invalid", COVCLAIMD_URL: "https://cov.invalid",
  SOLVER_REGISTRY_URLS: "https://registry.invalid", DB_PATH: "/data/lnurl.db", ALLOW_INSECURE_TOKEN_STORAGE: "1", FIXEDFLOAT_SIMULATE: "true",
};
const quiet = createLogger({ info: () => {}, warn: () => {}, error: () => {} });
const IDENTITY = { arkadeAddress: "ark1xyz", claimPublicKey: "02" + "ab".repeat(32), disabledRails: [] as string[] };

let db: Db; let sim: StartedFixedFloat;
beforeEach(async () => {
  db = openDb(":memory:"); runMigrations(db);
  sim = startFixedFloat({ config: loadConfig(SIMULATE).fixedFloat!, db, ttlMs: 86_400_000, logger: quiet });
  await pollUntil("simulated rates", async () => sim.deps.rates.snapshot().ready, 10_000, 10);
});
afterEach(() => { sim.stop(); db.close(); });

const caps = (): ServerRailCaps => ({
  offlineSwapCreator: true, discoveryReady: true, covenantDestinations: false,
  fixedFloat: { provider: sim.deps.provider.label, ...sim.deps.rates.snapshot() },
});

async function createOrder(ffCode: string) {
  const client = sim.deps.client;
  return client.create({ fromCcy: ffCode, toSat: 10_000, toAddress: "lntbs100u1simulated" }, client.reserveCreate()!);
}

describe("simulated token provider", () => {
  it("advertises ffsim- ids and never an ff- id", () => {
    const options = advertisedRailOptions(IDENTITY, caps(), { min: 1_000, max: 100_000_000 });
    expect(options.filter((o) => o.asset).map((o) => o.id)).toEqual(Object.keys(SIM_ASSETS).map((code) => `ffsim-${code.toLowerCase()}`));
    expect(options.some((o) => o.id.startsWith("ff-"))).toBe(false);
  });

  it('sets provider to "Simulated" on every option, and never names FixedFloat to an operator', () => {
    const options = advertisedRailOptions(IDENTITY, caps(), { min: 1_000, max: 100_000_000 }).filter((o) => o.asset);
    expect(options).toHaveLength(Object.keys(SIM_ASSETS).length);
    for (const option of options) expect(option.provider).toBe("Simulated");
    const row = describeServerRails(caps()).find((r) => r.id === "fixedfloat");
    expect(row?.label).toBe("Token deposits (Simulated)");
  });

  it("puts every simulated rail on a testnet BTCPay already labels, never a mainnet chain", () => {
    const mainnet = new Set(Object.values(FF_ASSETS).map((a) => a.chain));
    for (const [code, asset] of Object.entries(SIM_ASSETS)) {
      expect(BTCPAY_CHAINS, code).toContain(asset.chain);
      expect(mainnet.has(asset.chain), code).toBe(false);
    }
  });

  it("the simulated deposit address passes its namespace's address shape", async () => {
    for (const [code, asset] of Object.entries(SIM_ASSETS)) {
      const order = await createOrder(code);
      expect(order.id).toMatch(/^ffsim-[0-9a-f]{6}$/);
      expect(isValidAddress(namespaceOf(asset.chain), order.from.address), code).toBe(true);
    }
  });

  it("reports DONE with a chain-shaped deposit txid once the corridor swap behind it settles", async () => {
    const order = await createOrder("USDTARBITRUM");
    const hash = "aa".repeat(32);
    sim.deps.orders.createAccepted({
      paymentHash: hash, pr: "lntbs100u1simulated", sessionId: "offline:1", preimage: "bb".repeat(32), amountMsat: 10_000_000, paymentOption: "ffsim-usdtarbitrum",
      recovery: { version: 1, solverName: "s", solverPubkey: "11".repeat(32), relays: ["wss://relay.example"], rfqId: "rfq-1", lockupAddress: "tark1x", expectedAmount: 9_980, script: {} },
      order: { id: order.id, token: order.token, ffCode: "USDTARBITRUM", asset: `${SIM_ASSETS.USDTARBITRUM!.chain}/erc20:0x${"cd".repeat(20)}`, unit: "USDT",
        depositAddress: order.from.address, depositAmount: "8475000", invoiceAmountSat: 10_000, status: order.status, expiresAt: order.expiresAt! },
    });
    expect((await sim.deps.client.order(order.id, order.token)).status).toBe("NEW");

    const settlements = new DbSettlementStore(db, 86_400_000);
    settlements.markSettled(hash, "bb".repeat(32));
    await sim.onSettled(hash);
    const done = await sim.deps.client.order(order.id, order.token);
    expect(done.status).toBe("DONE");
    expect(done.from.txid).toMatch(/^0x[0-9a-f]{64}$/);
    expect(settlements.get(hash)).toMatchObject({ settled: true, paymentReference: done.from.txid });
  });

  it("answers the callback in the real rail's shapes, under its own name", async () => {
    const repos = createRepositories(db);
    const domainId = repos.domains.create({ domain: "domain.com", allocationModes: ["self"] }).id;
    const address = repos.addresses.create({ domainId, username: "alice", status: "active", sessionId: "s-alice" });
    repos.addresses.setOfflineReceive(address.id, IDENTITY.arkadeAddress, IDENTITY.claimPublicKey);
    const creator: OfflineSwapCreator = {
      isSettled: async () => false,
      create: async (p) => {
        const hash = createHash("sha256").update(String(p.amountSat)).digest("hex");
        return { swapId: "rfq-sim", invoice: buildInvoice(hash, { amountHrp: `${p.amountSat * 10}n` }), preimage: "11".repeat(32), preimageHash: hash,
          lockupAddress: "tark1x", invoiceExpiresAt: Math.floor(Date.now() / 1000) + 1_800,
          recovery: { version: 1, solverName: "s", solverPubkey: "11".repeat(32), relays: ["wss://relay.example"], rfqId: "rfq-sim", lockupAddress: "tark1x", expectedAmount: p.amountSat - 20, script: {} } };
      },
    };
    const server = http.createServer(createServer({ port: 0, baseUrl: "http://domain.com", minSendable: 1_000, maxSendable: 100_000_000 },
      { repos, addressService: new AddressService(repos, randomBytes(32)), settlements: new DbSettlementStore(db, 86_400_000),
        offlineSwapCreator: creator, offlineSwaps: new OfflineSwapStore(db, 86_400_000), fixedFloat: sim.deps }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as { port: number }).port;
      const body = await new Promise<any>((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/.well-known/lnurlp/alice/callback?amount=10000000&paymentOption=ffsim-usdtarbitrum`, { headers: { Host: "domain.com" } }, (res) => {
          let d = "";
          res.on("data", (c) => (d += c));
          res.on("end", () => resolve(JSON.parse(d)));
        }).on("error", reject);
      });
      expect(body).toMatchObject({ status: "OK", paymentOption: "ffsim-usdtarbitrum", provider: "Simulated", paymentQuote: { id: expect.stringMatching(/^ffsim-/), payment: { unit: "USDT" } } });
      expect(body.paymentURI).toMatch(/^ethereum:0x[0-9a-f]{40}@421614\/transfer\?address=0x[0-9a-f]{40}&uint256=\d+$/);
      expect(JSON.stringify(body)).not.toMatch(/FixedFloat/);
    } finally {
      await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
    }
  });

  it("the simulated provider is unreachable on the bitcoin network", () => {
    expect(() => assertFixedFloatNetwork(loadConfig(SIMULATE).fixedFloat, "bitcoin")).toThrow(/FIXEDFLOAT_SIMULATE/);
  });
});
