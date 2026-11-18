import { MultisigTapscript, VtxoScript, type IContractManager } from "@arkade-os/sdk";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COVENANT_CONTRACT_TYPE } from "../src/covenant/contract.js";
import { COVENANT_CURRENT, deriveCovenantDestination } from "../src/covenant/destination.js";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { createServer, type ServerDeps } from "../src/http/server.js";
import { DbSettlementStore } from "../src/settlement-store.js";
import { catchUp } from "../src/workers/covenant-watcher.js";

const DOMAIN = "domain.com";
const PAY_REQUEST = "/.well-known/lnurlp/alice";
const AMOUNT_SAT = 125_000;
const AMOUNT_MSAT = AMOUNT_SAT * 1000;
const xonly = (fill: number) => secp256k1.getPublicKey(new Uint8Array(32).fill(fill), true).subarray(1);
const serverPubkey = xonly(3);
const userPubkey = xonly(4);
const emulatorPubkey = xonly(5);
const staticAddress = new VtxoScript([
  MultisigTapscript.encode({ pubkeys: [userPubkey, serverPubkey] }).script,
]).address("ark", serverPubkey).encode();
const destinationFor = (nonce: number, operator = serverPubkey) => deriveCovenantDestination({
  staticAddress, userPubkey, serverPubkey: operator, emulatorPubkey,
  preimage: new Uint8Array(32).fill(nonce), recoveryDelaySeconds: 4096, version: COVENANT_CURRENT,
});

let db: Db;
let repos: Repositories;
let store: DbSettlementStore;
let addressId: number;

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
  repos = createRepositories(db);
  store = new DbSettlementStore(db, 86_400_000);
  const domain = repos.domains.create({ domain: DOMAIN, allocationModes: ["self"] });
  addressId = repos.addresses.create({ domainId: domain.id, username: "alice", status: "active" }).id;
  repos.addresses.setOfflineReceive(addressId, staticAddress, hex.encode(userPubkey));
});

afterEach(() => db.close());

function setup(overrides: Partial<ServerDeps> = {}) {
  let nonce = 0;
  const derive = vi.fn(async () => destinationFor(++nonce));
  const app = createServer({
    port: 0, baseUrl: `https://${DOMAIN}`, minSendable: 1000, maxSendable: 150_000_000,
  }, {
    repos, settlements: store, network: "bitcoin", satoraEnabled: true, satoraOperatorKey: hex.encode(serverPubkey),
    arkServerUrl: "https://arkade.computer", arkDustSat: 330,
    covenantDestinations: { derive },
    ...overrides,
  });
  const get = (path: string) => request(app).get(path).set("Host", DOMAIN);
  const quote = (amount = AMOUNT_MSAT, extra = {}) => get(`${PAY_REQUEST}/callback`)
    .query({ paymentOption: "satora", amount, ...extra });
  const options = async () => (await get(PAY_REQUEST)).body.paymentOptions as { id: string }[] | undefined;
  return { derive, quote, get, options };
}

function observe(script: string, value: number, txid: string) {
  const contracts = {
    getContractsWithVtxos: async ({ script: scripts }: { script: string[] }) => scripts.map((candidate) => ({
      contract: { type: COVENANT_CONTRACT_TYPE, script: candidate },
      vtxos: candidate === script ? [{ value, txid }] : [],
    })),
  } as unknown as IContractManager;
  return catchUp(store, contracts);
}

describe("Satora's direct Arkade rail", () => {
  it("issues a unique Arkade payout and credits only the matching funded request", async () => {
    const { get, quote, options } = setup();
    const advertised = await options();
    expect(advertised?.find(({ id }) => id === "satora")).toEqual({
      id: "satora", type: "satora", provider: "Satora", verifiable: true, minSendable: 335_000, maxSendable: 150_000_000,
    });
    expect(advertised?.map(({ id }) => id)).toEqual(expect.arrayContaining(["lightning", "arkade"]));

    const { body: first } = await quote(AMOUNT_MSAT, { comment: "Satora payment" });
    const { body: second } = await quote();
    expect(first).toMatchObject({
      status: "OK", paymentOption: "satora", verify: expect.any(String),
      verifyBatch: `https://${DOMAIN}/lnurl/verifyBatch`, expiresAt: expect.any(Number),
    });
    expect(first.paymentDestination).not.toBe(staticAddress);
    expect(second.paymentDestination).not.toBe(first.paymentDestination);
    expect(second.verify).not.toBe(first.verify);
    expect(first).not.toHaveProperty("paymentURI");
    expect(first).not.toHaveProperty("paymentQuote");

    const verifyPath = new URL(first.verify).pathname;
    const firstRecord = store.get(verifyPath.split("/").at(-1)!);
    expect(firstRecord).toMatchObject({
      paymentDestination: first.paymentDestination, amountMsat: AMOUNT_MSAT, comment: "Satora payment",
    });
    expect(firstRecord?.covenantScript).toMatch(/^5120[0-9a-f]{64}$/);
    const payoutScript = firstRecord!.covenantScript!;
    const pending = { status: "OK", settled: false, paymentOption: "satora", paymentDestination: first.paymentDestination };
    expect((await get(verifyPath)).body).toMatchObject({ ...pending, paymentReference: null });
    await expect(observe(payoutScript, AMOUNT_SAT - 1, "underpaid")).resolves.toBe(0);
    expect((await get(verifyPath)).body).toMatchObject(pending);
    await expect(observe(payoutScript, AMOUNT_SAT, "arkade-txid")).resolves.toBe(1);
    expect((await get(verifyPath)).body).toMatchObject({ ...pending, settled: true, paymentReference: "arkade-txid" });
    expect((await get(new URL(second.verify).pathname)).body).toMatchObject({ settled: false });
  });

  it.each<{ name: string; overrides: Partial<ServerDeps> }>([
    { name: "the opt-in flag", overrides: { satoraEnabled: undefined } },
    { name: "the mainnet operator network", overrides: { network: "mutinynet" } },
    { name: "an identified network", overrides: { network: undefined } },
    { name: "the covenant provider", overrides: { covenantDestinations: undefined } },
    { name: "a known Satora operator key", overrides: { satoraOperatorKey: undefined } },
    { name: "a matching Satora operator key", overrides: { satoraOperatorKey: hex.encode(xonly(6)) } },
  ])("omits and refuses Satora without $name", async ({ overrides }) => {
    const { derive, options, quote } = setup(overrides);
    expect((await options())?.map(({ id }) => id)).not.toContain("satora");
    expect((await quote()).body).toMatchObject({ status: "ERROR" });
    expect(derive).not.toHaveBeenCalled();
  });

  it("offers the same payout flow to a receiver's flagged session LNURL", async () => {
    const { domainId } = repos.addresses.getById(addressId)!;
    const receiver = repos.addresses.create({
      domainId, username: "bob", status: "active", sessionId: "session-bob", sessionLnurl: true,
    });
    repos.addresses.setOfflineReceive(receiver.id, staticAddress, hex.encode(userPubkey));
    const { get } = setup();
    const { body: meta } = await get("/lnurl/session-bob");
    expect(meta.paymentOptions).toContainEqual(expect.objectContaining({ id: "satora", verifiable: true }));
    const { body } = await get(new URL(meta.callback).pathname).query({ amount: AMOUNT_MSAT, paymentOption: "satora" });
    expect(body).toMatchObject({ status: "OK", paymentOption: "satora", verify: expect.any(String) });
  });

  it.each(["satora", "covenant"] as const)("honors the per-address %s policy", async (rail) => {
    repos.addresses.setDisabledRails(addressId, [rail]);
    const { derive, options, quote } = setup();
    expect((await options())?.map(({ id }) => id)).not.toContain("satora");
    expect((await quote()).body).toMatchObject({ status: "ERROR" });
    expect(derive).not.toHaveBeenCalled();

    repos.addresses.setDisabledRails(addressId, []);
    expect((await options())?.map(({ id }) => id)).toContain("satora");
    expect((await quote()).body).toMatchObject({ status: "OK", paymentOption: "satora" });
  });

  it("refuses unsupported amounts, unit quotes, and unavailable derivation", async () => {
    const { quote } = setup({ covenantDestinations: {
      derive: vi.fn(async () => { throw new Error("operator is unreachable"); }),
    } });
    for (const [amount, extra, reason] of [
      [334_000, {}, /between/],
      [AMOUNT_MSAT + 1, {}, /whole number of satoshis/],
      [150_001_000, {}, /between/],
      [AMOUNT_MSAT, { unit: "USD" }, /unit/],
      [AMOUNT_MSAT, { unit: ["USD", "EUR"] }, /unit/],
      [AMOUNT_MSAT, { receiveUnit: "USD" }, /unit/],
      [AMOUNT_MSAT, { receiveAmount: AMOUNT_MSAT }, /receiveAmount/],
    ] as const) {
      expect((await quote(amount, extra)).body).toMatchObject({ status: "ERROR", reason: expect.stringMatching(reason) });
    }
    const { body } = await quote();
    expect(body).toMatchObject({ status: "ERROR" });
    expect(body.paymentDestination).toBeUndefined();
    expect(body.paymentURI).toBeUndefined();
    expect(store.listRecent(10)).toEqual([]);
  });

  it("refuses a derived destination from another operator", async () => {
    const { quote } = setup({ covenantDestinations: { derive: async () => destinationFor(1, xonly(6)) } });
    const { body } = await quote();
    expect(body).toMatchObject({ status: "ERROR" });
    expect(body.paymentDestination).toBeUndefined();
    expect(store.listRecent(10)).toEqual([]);
  });
});
