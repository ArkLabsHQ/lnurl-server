import { MultisigTapscript, VtxoScript, type IContractManager } from "@arkade-os/sdk";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { Asset, getCctpBridgeTokens } from "@satora/swap";
import { base58, hex } from "@scure/base";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COVENANT_CONTRACT_TYPE } from "../src/covenant/contract.js";
import { COVENANT_CURRENT, deriveCovenantDestination } from "../src/covenant/destination.js";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { createServer, type ServerDeps } from "../src/http/server.js";
import { SATORA_PAYMENT_OPTION as OPTION, SatoraCapacityError, type SatoraCheckout } from "../src/rails/satora.js";
import { SATORA_SOURCES, satoraSource } from "../src/rails/satora-catalogue.js";
import { createVerifyBatch } from "../src/services/verify-batch.js";
import { DbSettlementStore } from "../src/settlement-store.js";
import { catchUp } from "../src/workers/covenant-watcher.js";
import { createLnurlClient, normalizeTokenQuote, tokenOptions } from "../packages/client/src/index.js";

const DOMAIN = "domain.com";
const PAY_REQUEST = "/.well-known/lnurlp/alice";
const AMOUNT_SAT = 125_000;
const AMOUNT_MSAT = AMOUNT_SAT * 1000;
const TOKEN = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const SOURCE_AMOUNT = "109747023";
const FUNDING_TXID = `0x${"d".repeat(64)}`;
const depositFor = (nonce: number) => `0x${nonce.toString(16).padStart(40, "b")}`;
const solanaDepositFor = (nonce: number) => base58.encode(new Uint8Array(32).fill(nonce));
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
  let orders = 0;
  const ordersBySwapId = new Map<string, { verifyId: string; optionId: string }>();
  const derive = vi.fn(async () => destinationFor(++nonce));
  const create = vi.fn<SatoraCheckout["create"]>(async ({ optionId, verifyId, deriveRecipient }) => {
    const recipient = await deriveRecipient();
    const sequence = ++orders;
    const swapId = `private-swap-${sequence}`;
    const depositAddress = satoraSource(optionId)?.type === "solana" ? solanaDepositFor(sequence) : depositFor(sequence);
    ordersBySwapId.set(swapId, { verifyId, optionId });
    return { swapId, depositAddress, sourceAmount: SOURCE_AMOUNT, expiresAt: Date.now() + 300_000, covenantScript: recipient.script };
  });
  const activate = vi.fn<SatoraCheckout["activate"]>((id) => {
    const { verifyId, optionId } = ordersBySwapId.get(id)!;
    expect(store.get(verifyId)).toMatchObject({ paymentOption: optionId });
  });
  const app = createServer({
    port: 0, baseUrl: `https://${DOMAIN}`, minSendable: 1000, maxSendable: 150_000_000,
  }, {
    repos, settlements: store, network: "bitcoin", satoraEnabled: true, satoraOperatorKey: hex.encode(serverPubkey),
    arkServerUrl: "https://arkade.computer", arkDustSat: 330,
    covenantDestinations: { derive }, satora: { create, activate },
    ...overrides,
  });
  const get = (path: string) => request(app).get(path).set("Host", DOMAIN);
  const quote = (amount = AMOUNT_MSAT, extra = {}) => get(`${PAY_REQUEST}/callback`)
    .query({ paymentOption: OPTION, amount, ...extra });
  const options = async () => (await get(PAY_REQUEST)).body.paymentOptions as { id: string }[] | undefined;
  const client = createLnurlClient({ fetchImpl: async (input) => {
    const url = new URL(String(input));
    const response = await get(`${url.pathname}${url.search}`);
    return Response.json(response.body, { status: response.status });
  } });
  return { create, activate, client, derive, quote, get, options };
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

describe("Satora's Arkade rail", () => {
  it("uses every native CCTP USDC contract from the pinned SDK", () => {
    const compare = (a: { chain: string }, b: { chain: string }) => a.chain.localeCompare(b.chain);
    const expected = getCctpBridgeTokens().map(({ chain, token_id }) => ({
      chain, token: chain === "Solana" ? token_id : token_id.toLowerCase(),
    })).sort(compare);
    const actual = SATORA_SOURCES.filter(({ mode }) => mode === "cctp").map(({ chain, token }) => ({
      chain, token: chain === "Solana" ? token : token.toLowerCase(),
    })).sort(compare);
    expect(actual).toEqual(expected);
    expect(satoraSource(OPTION)?.token.toLowerCase()).toBe(Asset.USDC_POLYGON.tokenId.toLowerCase());
    expect(satoraSource("satora-usdcarbitrum")?.token.toLowerCase()).toBe(Asset.USDC_ARBITRUM.tokenId.toLowerCase());
  });

  it("issues a token quote and credits only the matching funded Arkade covenant", async () => {
    const polygonReferences = new Map<string, string>();
    const satoraFundingReference = (verifyId: string) => polygonReferences.get(verifyId);
    const { activate, create, get, quote, options } = setup({ satoraFundingReference });
    const advertised = await options();
    expect(advertised?.find(({ id }) => id === OPTION)).toEqual({
      id: OPTION, type: "eip155", asset: `eip155:137/erc20:${TOKEN}`, unit: "USDC", provider: "Satora",
      verifiable: true, minSendable: 335_000, maxSendable: 150_000_000,
    });
    expect(advertised?.map(({ id }) => id)).toEqual(expect.arrayContaining(["lightning", "arkade"]));
    expect((await get(PAY_REQUEST)).body.units).toContainEqual({ code: "USDC", decimals: 6, name: "USD Coin" });

    const { body: first } = await quote(AMOUNT_MSAT, { comment: "Satora payment" });
    const { body: second } = await quote();
    expect(first).toMatchObject({
      status: "OK", paymentOption: OPTION, provider: "Satora", verify: expect.any(String),
      verifyBatch: `https://${DOMAIN}/lnurl/verifyBatch`, paymentDestination: depositFor(1),
      paymentURI: `ethereum:${TOKEN}@137/transfer?address=${depositFor(1)}&uint256=${SOURCE_AMOUNT}`,
      paymentQuote: {
        requested: { amount: String(AMOUNT_MSAT), unit: "msat" },
        receive: { amount: String(AMOUNT_MSAT), unit: "msat" },
        payment: { amount: SOURCE_AMOUNT, unit: "USDC" },
        expiresAt: expect.any(String),
      },
    });
    expect(second.paymentDestination).toBe(depositFor(2));
    expect(second.verify).not.toBe(first.verify);
    expect(first).not.toHaveProperty("expiresAt");
    expect(JSON.stringify(first)).not.toContain("private-swap");
    expect(activate).toHaveBeenNthCalledWith(1, "private-swap-1");

    const verifyPath = new URL(first.verify).pathname;
    const verifyId = verifyPath.split("/").at(-1)!;
    polygonReferences.set(verifyId, FUNDING_TXID);
    expect(create).toHaveBeenNthCalledWith(1, expect.objectContaining({ optionId: OPTION, verifyId, addressId, amountSat: AMOUNT_SAT }));
    const firstRecord = store.get(verifyId);
    expect(firstRecord).toMatchObject({
      paymentDestination: first.paymentDestination, amountMsat: AMOUNT_MSAT, comment: "Satora payment",
      expiresAt: Date.parse(first.paymentQuote.expiresAt),
    });
    expect(firstRecord?.covenantScript).toBe(destinationFor(1).script);
    const payoutScript = firstRecord!.covenantScript!;
    const pending = { status: "OK", settled: false, paymentOption: OPTION, paymentDestination: first.paymentDestination };
    expect((await get(verifyPath)).body).toMatchObject({ ...pending, paymentReference: null });
    await expect(observe(payoutScript, AMOUNT_SAT - 1, "underpaid")).resolves.toBe(0);
    expect((await get(verifyPath)).body).toMatchObject(pending);
    await expect(observe(payoutScript, AMOUNT_SAT, "arkade-txid")).resolves.toBe(1);
    expect((await get(verifyPath)).body).toMatchObject({ ...pending, settled: true, paymentReference: FUNDING_TXID });
    expect(store.get(verifyId)?.paymentReference).toBe("arkade-txid");
    const batch = await get(new URL(first.verifyBatch).pathname).query({ verify: [first.verify, second.verify] });
    expect(batch.body.results[first.verify]).toMatchObject({ ...pending, settled: true, paymentReference: FUNDING_TXID });
    expect(batch.body.results[second.verify]).toMatchObject({ settled: false, paymentReference: null });
    expect((await get(new URL(second.verify).pathname)).body).toMatchObject({ settled: false });
    const { get: afterDisabled } = setup({ satoraEnabled: undefined, satora: undefined, satoraFundingReference });
    expect((await afterDisabled(verifyPath)).body).toMatchObject({ settled: true, paymentReference: FUNDING_TXID });
  });

  it("streams the Polygon reference when it becomes available after the Arkade receipt", async () => {
    const { quote } = setup();
    const { body: { verify } } = await quote();
    const verifyId = new URL(verify).pathname.split("/").at(-1)!;
    expect(store.markObserved(verifyId, "arkade-txid")).toBe(true);
    let reference: string | undefined;
    vi.useFakeTimers();
    const batch = createVerifyBatch({
      store, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      config: { pollMs: 10 }, satoraFundingReference: () => reference,
    });
    try {
      const write = vi.fn();
      const end = vi.fn();
      batch.openStream([verify], { write, end, writableEnded: false });
      expect(write).toHaveBeenLastCalledWith(expect.stringContaining('"paymentReference":null'));
      expect(end).not.toHaveBeenCalled();
      reference = FUNDING_TXID;
      await vi.advanceTimersByTimeAsync(10);
      expect(write).toHaveBeenLastCalledWith(expect.stringContaining(`"paymentReference":"${FUNDING_TXID}"`));
      expect(end).toHaveBeenCalledTimes(1);
    } finally {
      batch.stop();
      vi.useRealTimers();
    }
  });

  it("works through the shared payer's token option and QR parser", async () => {
    const { client } = setup();
    const pay = await client.resolve(`alice@${DOMAIN}`);
    const token = tokenOptions(pay).find(({ id }) => id === OPTION);
    expect(token).toMatchObject({ provider: "Satora", unit: { code: "USDC", decimals: 6 } });
    const result = await client.requestInvoice(pay, { amountSat: AMOUNT_SAT, paymentOption: OPTION });
    expect(result.kind).toBe("destination");
    if (result.kind !== "destination") throw new Error("expected token destination");
    expect(normalizeTokenQuote(token!, result)).toMatchObject({
      destination: depositFor(1), amount: "109.747023", baseUnits: SOURCE_AMOUNT,
      value: `ethereum:${TOKEN}@137/transfer?address=${depositFor(1)}&uint256=${SOURCE_AMOUNT}`,
    });
  });

  it.each(SATORA_SOURCES)("quotes the exact asset for $id", async (source) => {
    const { client, create } = setup();
    const pay = await client.resolve(`alice@${DOMAIN}`);
    const token = tokenOptions(pay).find(({ id }) => id === source.id);
    expect(token).toMatchObject({ provider: "Satora", asset: { id: source.asset }, unit: { code: source.unit, decimals: source.decimals } });
    const result = await client.requestInvoice(pay, { amountSat: AMOUNT_SAT, paymentOption: source.id });
    if (result.kind !== "destination") throw new Error("expected token destination");
    const destination = source.type === "solana" ? solanaDepositFor(1) : depositFor(1);
    const quote = normalizeTokenQuote(token!, result);
    expect(quote).toMatchObject({ destination, baseUnits: SOURCE_AMOUNT });
    expect(quote!.value).toBe(source.type === "solana"
      ? `solana:${destination}?amount=109.747023&spl-token=${source.token}`
      : `ethereum:${source.token}@${source.chain}/transfer?address=${destination}&uint256=${SOURCE_AMOUNT}`);
    expect(create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ optionId: source.id, amountSat: AMOUNT_SAT }));
  });

  it("refuses unknown source IDs before allocating a deposit", async () => {
    const { derive, quote } = setup();
    expect((await quote(AMOUNT_MSAT, { paymentOption: "satora-usdcunknown" })).body).toEqual({
      status: "ERROR", reason: "Unsupported paymentOption",
    });
    expect(derive).not.toHaveBeenCalled();
  });

  it("does not offer or allocate a route whose funding path is unavailable", async () => {
    const create = vi.fn<SatoraCheckout["create"]>();
    const disabled = SATORA_SOURCES.find(({ id }) => id !== OPTION)!;
    const { derive, options, quote } = setup({ satora: { isAvailable: (optionId) => optionId !== disabled.id, create, activate: vi.fn() } });
    const ids = (await options())?.map(({ id }) => id);
    expect(ids).toContain(OPTION);
    expect(ids).not.toContain(disabled.id);
    expect((await quote(AMOUNT_MSAT, { paymentOption: disabled.id })).body.status).toBe("ERROR");
    expect(derive).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a Satora option when a configured quote unit has different decimals", async () => {
    const optionId = "satora-eurearbitrum";
    const { create, options, quote } = setup({ quoteProvider: {
      units: () => [{ code: "EURE", decimals: 2 }], quote: vi.fn(),
    } });
    const ids = (await options())?.map(({ id }) => id);
    expect(ids).toContain(OPTION);
    expect(ids).not.toContain(optionId);
    expect((await quote(AMOUNT_MSAT, { paymentOption: optionId })).body.status).toBe("ERROR");
    expect(create).not.toHaveBeenCalled();
  });

  it("verifies settlement with a source-chain funding reference for an additional option", async () => {
    const source = SATORA_SOURCES.find(({ id, type }) => id !== OPTION && type === "eip155")!;
    const { get, quote } = setup({ satoraFundingReference: () => FUNDING_TXID });
    const { body: { verify, verifyBatch } } = await quote(AMOUNT_MSAT, { paymentOption: source.id });
    const verifyPath = new URL(verify).pathname;
    const verifyId = verifyPath.split("/").at(-1)!;
    expect(store.markObserved(verifyId, "arkade-txid")).toBe(true);
    const { body } = await get(verifyPath);
    expect(body).toMatchObject({ settled: true, paymentOption: source.id, paymentReference: FUNDING_TXID });
    const batch = await get(new URL(verifyBatch).pathname).query({ verify });
    expect(batch.body.results[verify]).toMatchObject({ settled: true, paymentOption: source.id, paymentReference: FUNDING_TXID });
  });

  it.each<{ name: string; overrides: Partial<ServerDeps> }>([
    { name: "the opt-in flag", overrides: { satoraEnabled: undefined } },
    { name: "the mainnet operator network", overrides: { network: "mutinynet" } },
    { name: "an identified network", overrides: { network: undefined } },
    { name: "the covenant provider", overrides: { covenantDestinations: undefined } },
    { name: "the checkout service", overrides: { satora: undefined } },
    { name: "a known Satora operator key", overrides: { satoraOperatorKey: undefined } },
    { name: "a matching Satora operator key", overrides: { satoraOperatorKey: hex.encode(xonly(6)) } },
  ])("omits and refuses Satora without $name", async ({ overrides }) => {
    const { derive, options, quote } = setup(overrides);
    expect((await options())?.map(({ id }) => id)).not.toContain(OPTION);
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
    expect(meta.paymentOptions).toContainEqual(expect.objectContaining({ id: OPTION, verifiable: true }));
    const { body } = await get(new URL(meta.callback).pathname).query({ amount: AMOUNT_MSAT, paymentOption: OPTION });
    expect(body).toMatchObject({ status: "OK", paymentOption: OPTION, verify: expect.any(String) });
  });

  it.each(["satora", "covenant"] as const)("honors the per-address %s policy", async (rail) => {
    repos.addresses.setDisabledRails(addressId, [rail]);
    const { derive, options, quote } = setup();
    expect((await options())?.map(({ id }) => id)).not.toContain(OPTION);
    expect((await quote()).body).toMatchObject({ status: "ERROR" });
    expect(derive).not.toHaveBeenCalled();

    repos.addresses.setDisabledRails(addressId, []);
    expect((await options())?.map(({ id }) => id)).toContain(OPTION);
    expect((await quote()).body).toMatchObject({ status: "OK", paymentOption: OPTION });
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

  it("refuses checkout capacity before deriving a covenant", async () => {
    const { derive, quote } = setup({ satora: {
      create: async () => { throw new SatoraCapacityError(); }, activate: vi.fn(),
    } });
    const { status, body } = await quote();
    expect(status).toBe(429);
    expect(body).toMatchObject({ status: "ERROR" });
    expect(derive).not.toHaveBeenCalled();
    expect(store.listRecent(10)).toEqual([]);
  });

  it.each(["malformed quote", "failed activation"])("does not expose the deposit after a %s", async (failure) => {
    const activate = vi.fn(() => { throw new Error("private-provider-data"); });
    const { quote } = setup({ satora: {
      create: async ({ deriveRecipient }) => ({
        swapId: "private-order", depositAddress: depositFor(1),
        sourceAmount: failure === "malformed quote" ? "1.25" : SOURCE_AMOUNT,
        expiresAt: Date.now() + 300_000, covenantScript: (await deriveRecipient()).script,
      }),
      activate,
    } });
    const { body } = await quote();
    expect(body).toEqual({ status: "ERROR", reason: `paymentOption ${OPTION} is currently unavailable` });
    expect(activate).toHaveBeenCalledTimes(failure === "malformed quote" ? 0 : 1);
  });
});
