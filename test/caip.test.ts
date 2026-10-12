import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { caip19Id, matchCaip19Id, isRailType } from "../src/caip.js";
import { advertisedRailOptions } from "../src/rails.js";
import { resolvePaymentOption } from "../src/payment-options.js";
import { createServer } from "../src/http/server.js";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories } from "../src/db/repositories/index.js";

const ADDRESS = {
  arkadeAddress: "tark1qexample",
  claimPublicKey: "02".repeat(16),
  boardingAddress: "tb1qexample",
  disabledRails: [] as const,
};
const CAPS = { offlineSwapCreator: true, discoveryReady: true, covenantDestinations: false, arkServerUrl: "http://arkd" };

describe("caip19Id", () => {
  it("pairs slip44:0 with mainnet and slip44:1 with every testnet", () => {
    expect(caip19Id("arkade", "bitcoin")).toBe("arkade:bitcoin/slip44:0");
    expect(caip19Id("lightning", "mutinynet")).toBe("bolt11:mutinynet/slip44:1");
    expect(caip19Id("onchain", "signet")).toBe("bitcoin:signet/slip44:1");
    expect(caip19Id("onchain", "regtest")).toBe("bitcoin:regtest/slip44:1");
  });

  it("uses the chain namespace intent-solver files the corridor under", () => {
    expect(caip19Id("lightning", "bitcoin").startsWith("bolt11:")).toBe(true);
    expect(caip19Id("onchain", "bitcoin").startsWith("bitcoin:")).toBe(true);
  });

  it("recognises exactly the three rail types", () => {
    expect(["lightning", "arkade", "onchain"].every(isRailType)).toBe(true);
    expect(isRailType("covenant")).toBe(false);
  });
});

describe("matchCaip19Id", () => {
  it("round-trips every rail on its own network", () => {
    for (const type of ["lightning", "arkade", "onchain"] as const) {
      expect(matchCaip19Id(caip19Id(type, "mutinynet"), "mutinynet")).toEqual({ kind: "rail", type });
    }
  });

  it("tells a wrong network apart from a malformed id", () => {
    expect(matchCaip19Id("arkade:bitcoin/slip44:0", "mutinynet")).toEqual({ kind: "wrong-network", got: "bitcoin" });
    expect(matchCaip19Id("arkade:nonsense/slip44:1", "mutinynet")).toEqual({ kind: "unknown" });
    expect(matchCaip19Id("nonsense:mutinynet/slip44:1", "mutinynet")).toEqual({ kind: "unknown" });
  });

  it("rejects an id with extra segments instead of dropping the tail", () => {
    expect(matchCaip19Id("bolt11:bitcoin:extra/slip44:0", "bitcoin")).toEqual({ kind: "unknown" });
    expect(matchCaip19Id("arkade:bitcoin/slip44:0/extra", "bitcoin")).toEqual({ kind: "unknown" });
  });

  it("rejects a coin type that is not BTC on a BTC-only rail", () => {
    expect(matchCaip19Id("arkade:bitcoin/slip44:60", "bitcoin")).toEqual({ kind: "unknown" });
    expect(matchCaip19Id("arkade:mutinynet/slip44:0", "mutinynet")).toEqual({ kind: "unknown" });
  });
});

describe("advertisedRailOptions", () => {
  it("omits caip19Id when the network is unknown", () => {
    for (const option of advertisedRailOptions(ADDRESS, CAPS)) {
      expect(option.caip19Id).toBeUndefined();
    }
  });

  it("carries one alongside every option once the network is known", () => {
    const options = advertisedRailOptions(ADDRESS, { ...CAPS, network: "mutinynet" });
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(option.caip19Id).toBe(caip19Id(option.type as "arkade", "mutinynet"));
      // `id` is untouched, which is what keeps an installed payer working.
      expect(option.id).toBe(option.type);
    }
  });
});

describe("resolvePaymentOption", () => {
  it("resolves a CAIP-19 id to the same destination as the bare name", () => {
    const bare = resolvePaymentOption("arkade", ADDRESS);
    const caip = resolvePaymentOption("arkade:mutinynet/slip44:1", ADDRESS, [], "mutinynet");
    expect(caip).toEqual(bare);
    expect(caip).toMatchObject({ kind: "destination", paymentDestination: ADDRESS.arkadeAddress });
  });

  it("still accepts the bare name with a network configured", () => {
    expect(resolvePaymentOption("onchain", ADDRESS, [], "mutinynet"))
      .toMatchObject({ kind: "destination", paymentOption: "onchain" });
  });

  it("names the network in the error when a payer is pointed at the wrong one", () => {
    const result = resolvePaymentOption("arkade:bitcoin/slip44:0", ADDRESS, [], "mutinynet");
    expect(result).toMatchObject({ kind: "error" });
    expect((result as { reason: string }).reason).toContain("mutinynet");
    expect((result as { reason: string }).reason).toContain("bitcoin");
  });

  it("refuses a CAIP-19 id when the server does not know its own network", () => {
    expect(resolvePaymentOption("arkade:mutinynet/slip44:1", ADDRESS)).toMatchObject({ kind: "error" });
  });

  it("maps the bolt11 namespace onto the lightning flow", () => {
    expect(resolvePaymentOption("bolt11:mutinynet/slip44:1", ADDRESS, [], "mutinynet")).toEqual({ kind: "lightning" });
  });

  it("keeps token deposit selectors available with a network configured", () => {
    expect(resolvePaymentOption("ff-usdttrc", ADDRESS, [{ optionId: "ff-usdttrc", ffCode: "USDTTRC" }], "mutinynet"))
      .toEqual({ kind: "fixedfloat", optionId: "ff-usdttrc", ffCode: "USDTTRC" });
  });
});

describe.each([
  { label: "named", path: "/.well-known/lnurlp/alice", sessionLnurl: false },
  { label: "nameless", path: "/lnurl/sess-alice", sessionLnurl: true },
])("CAIP-19 $label HTTP payment flow", ({ path, sessionLnurl }) => {
  let db: Db;
  let app: ReturnType<typeof createServer>;

  beforeEach(() => {
    db = openDb(":memory:");
    runMigrations(db);
    const repos = createRepositories(db);
    const domain = repos.domains.create({ domain: "domain.com", allocationModes: ["self"] });
    const address = repos.addresses.create({ domainId: domain.id, username: "alice", status: "active", sessionId: "sess-alice", sessionLnurl });
    repos.addresses.setOfflineReceive(address.id, ADDRESS.arkadeAddress, ADDRESS.claimPublicKey);
    app = createServer(
      { port: 0, baseUrl: "http://domain.com", minSendable: 1000, maxSendable: 100_000_000 },
      {
        repos, arkServerUrl: CAPS.arkServerUrl, network: "mutinynet",
        quoteProvider: {
          units: (option) => option === undefined || option === "lightning" ? [{ code: "usd", decimals: 2, maxAmount: "10" }] : [],
          quote: (req) => ({ requested: { amount: String(req.amount), unit: "usd" }, payment: { amount: "50000", unit: "msat" } }),
        },
      },
    );
  });

  afterEach(() => db.close());

  it("advertises the sidecar and resolves its callback through the current router", async () => {
    const metadata = await request(app).get(path).set("Host", "domain.com");
    expect(metadata.body.paymentOptions).toContainEqual({ id: "arkade", type: "arkade", caip19Id: "arkade:mutinynet/slip44:1", verifiable: false });
    const callback = await request(app).get(`${path}/callback`).query({ amount: 50000, paymentOption: "arkade:mutinynet/slip44:1" }).set("Host", "domain.com");
    expect(callback.body).toMatchObject({ paymentOption: "arkade", paymentDestination: ADDRESS.arkadeAddress });
  });

  it("rejects the wrong network before issuing a destination", async () => {
    const callback = await request(app).get(`${path}/callback`).query({ amount: 50000, paymentOption: "arkade:bitcoin/slip44:0" }).set("Host", "domain.com");
    expect(callback.body).toMatchObject({ status: "ERROR", reason: "paymentOption settles on bitcoin, this service settles on mutinynet" });
    expect(callback.body.paymentDestination).toBeUndefined();
  });

  it("enforces the Lightning quote provider's unit bounds for its CAIP alias", async () => {
    const callback = await request(app).get(`${path}/callback`).query({ amount: 20, unit: "usd", paymentOption: "bolt11:mutinynet/slip44:1" }).set("Host", "domain.com");
    expect(callback.body).toMatchObject({ status: "ERROR", reason: "Amount above usd maximum (10)" });
  });
});
