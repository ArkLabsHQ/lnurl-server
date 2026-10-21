import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { bech32 } from "@scure/base";
import { ArkAddress } from "@arkade-os/sdk";
import { createServer } from "../src/http/server.js";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { AddressService } from "../src/services/addresses.js";
import { DbSettlementStore, MemorySettlementStore, type SettlementStore } from "../src/settlement-store.js";
import { OfflineSwapStore } from "../src/offline-swap-store.js";
import { encryptToken } from "../src/crypto.js";
import { deriveSessionId } from "../src/session-token.js";
import type { OfflineSwapCreator, OfflineSwapParams, OfflineSwapResult } from "../src/services/offline-swaps.js";
import { RailRefusedError } from "../src/errors.js";
import type { LnurlServiceConfig } from "../src/types/index.js";

const KEY = randomBytes(32);
const CONFIG: LnurlServiceConfig = { port: 0, baseUrl: "", minSendable: 1000, maxSendable: 100_000_000, invoiceTimeoutMs: 3000 };
const TOKEN = "cd".repeat(32);
const RECEIVE = new ArkAddress(new Uint8Array(32), new Uint8Array(32), "tark").encode();
const CLAIM_PUBKEY = "02" + "ab".repeat(32);

function buildInvoice(paymentHashHex: string, amountSat?: number): string {
  const words: number[] = [];
  for (let i = 0; i < 7; i++) words.push(0);
  const hw = bech32.toWords(Uint8Array.from(Buffer.from(paymentHashHex, "hex")));
  words.push(1, 52 >> 5, 52 & 31, ...hw);
  for (let i = 0; i < 104; i++) words.push(0);
  return bech32.encode(amountSat === undefined ? "lnbc" : `lnbc${amountSat * 10000}p`, words, 2000);
}

/** Deterministic in-memory offline-swap creator for tests. */
class FakeCreator implements OfflineSwapCreator {
  created: OfflineSwapParams[] = [];
  settledIds = new Set<string>();
  release = vi.fn(async (_swapId: string) => {});
  constructor(private hashHex: string) {}
  async create(params: OfflineSwapParams): Promise<OfflineSwapResult> {
    this.created.push(params);
    return {
      swapId: "swap-1",
      invoice: buildInvoice(this.hashHex, params.amountSide === "to" ? params.amountSat + 1 : undefined),
      preimage: "11".repeat(32),
      preimageHash: this.hashHex,
      lockupAddress: RECEIVE,
      recovery: {
        version: 1,
        solverName: "fake",
        solverPubkey: "11".repeat(32),
        relays: ["wss://relay.invalid"],
        rfqId: "swap-1",
        lockupAddress: RECEIVE,
        expectedAmount: params.amountSat,
        script: {},
      },
    };
  }
  async isSettled(swapId: string): Promise<boolean> {
    return this.settledIds.has(swapId);
  }
}

function start(repos: Repositories, creator?: OfflineSwapCreator, settlements?: SettlementStore, offlineSwaps?: OfflineSwapStore) {
  const server = http.createServer();
  const addressService = new AddressService(repos, KEY);
  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${port}`;
      server.on(
        "request",
        createServer(
          { ...CONFIG, baseUrl },
          { repos, addressService, settlements, offlineSwapCreator: creator, offlineSwaps },
        ),
      );
      resolve({ baseUrl, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) });
    });
  });
}

function req(url: string, method: string, host: string, body?: unknown, token?: string) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json", Host: host };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const r = http.request(url, { method, headers }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: d ? JSON.parse(d) : {} }));
    });
    r.on("error", reject); if (body) r.write(JSON.stringify(body)); r.end();
  });
}

let db: Db; let repos: Repositories; let ctx: Awaited<ReturnType<typeof start>>;
let addressId: number;

beforeEach(() => {
  db = openDb(":memory:"); runMigrations(db); repos = createRepositories(db);
  const domainId = repos.domains.create({ domain: "domain.com", allocationModes: ["self", "session"] }).id;
  addressId = repos.addresses.create({
    domainId, username: "off", status: "active",
    sessionId: deriveSessionId(TOKEN), encryptedToken: encryptToken(TOKEN, KEY),
  }).id;
});
afterEach(async () => { await ctx.close(); db.close(); });

describe("offline receive", () => {
  it("registers an arkade receive identity via POST /lnurl/address/:handle/arkade", async () => {
    ctx = await start(repos);
    const res = await req(`${ctx.baseUrl}/lnurl/address/off/arkade`, "POST", "domain.com", { arkadeAddress: RECEIVE, claimPublicKey: CLAIM_PUBKEY }, TOKEN);
    expect(res.status).toBe(200);
    expect(repos.addresses.getById(addressId)!.arkadeAddress).toBe(RECEIVE);
  });

  it("rejects the arkade registration without the owning token", async () => {
    ctx = await start(repos);
    const res = await req(`${ctx.baseUrl}/lnurl/address/off/arkade`, "POST", "domain.com", { arkadeAddress: RECEIVE, claimPublicKey: CLAIM_PUBKEY }, "ab".repeat(32));
    expect(res.status).toBe(404);
  });

  it("creates a swap and returns invoice + verify when the wallet is offline", async () => {
    const hash = "9a" + "00".repeat(31);
    const creator = new FakeCreator(hash);
    const settlements = new DbSettlementStore(db, 60_000);
    const offlineSwaps = new OfflineSwapStore(db, 60_000);
    repos.addresses.setOfflineReceive(addressId, RECEIVE, CLAIM_PUBKEY);
    ctx = await start(repos, creator, settlements, offlineSwaps);

    const res = await req(`${ctx.baseUrl}/.well-known/lnurlp/off/callback?amount=50000`, "GET", "domain.com");
    expect(res.body.pr).toBe(buildInvoice(hash));
    expect(res.body.verify).toBe(`${ctx.baseUrl}/lnurl/verify/${hash}`);
    // amount converted msat -> sat, and the user's identity forwarded
    expect(creator.created[0]).toEqual({ amountSat: 50, receiveAddress: RECEIVE, claimPublicKey: CLAIM_PUBKEY });
    expect(offlineSwaps.listPending()[0]?.recovery).toMatchObject({ solverName: "fake", rfqId: "swap-1" });

    // verify is registered but not yet settled (poller hasn't run)
    const v = await req(`${ctx.baseUrl}/lnurl/verify/${hash}`, "GET", "domain.com");
    expect(v.body).toMatchObject({ status: "OK", settled: false, preimage: null });
  });

  it("creates a net-priced invoice without owner credentials and persists the gross invoice amount", async () => {
    const hash = "ac".repeat(32);
    const creator = new FakeCreator(hash);
    const store = new DbSettlementStore(db, 60_000);
    const recovery = new OfflineSwapStore(db, 60_000);
    ctx = await start(repos, creator, store, recovery);
    await req(`${ctx.baseUrl}/lnurl/address/off/arkade`, "POST", "domain.com", { arkadeAddress: RECEIVE, claimPublicKey: CLAIM_PUBKEY }, TOKEN);
    const response = await req(`${ctx.baseUrl}/.well-known/lnurlp/off/invoice`, "POST", "domain.com", { receiveAmountMsat: 1000000, maxPayAmountMsat: 1050000 });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      verify: `${ctx.baseUrl}/lnurl/verify/${hash}`,
      verifyBatch: `${ctx.baseUrl}/lnurl/verifyBatch`,
      paymentQuote: {
        requested: { amount: "1000000", unit: "msat" },
        payment: { amount: "1001000", unit: "msat" },
        receive: { amount: "1000000", unit: "msat" },
        fees: [{ name: "solver", amount: { amount: "1000", unit: "msat" } }],
      },
    });
    expect(creator.created[0]).toMatchObject({ amountSat: 1000, amountSide: "to", maxPayAmountSat: 1050, receiveAddress: RECEIVE });
    expect(store.get(hash)?.amountMsat).toBe(1001000);
    expect(new OfflineSwapStore(db, 60_000).listPending()[0]).toMatchObject({ paymentHash: hash, recovery: { expectedAmount: 1000 } });
    expect(store.get(hash)?.quote).toEqual({ amount: "1000", unit: "sat", decimals: 0 });
    expect(JSON.stringify(response.body)).not.toContain('"preimage"');
    expect(JSON.stringify(response.body)).not.toContain(TOKEN);
    expect((await req(`${ctx.baseUrl}/lnurl/verify/${hash}`, "GET", "domain.com")).body).toMatchObject({ settled: false });
  });

  it.each([
    { receiveAmountMsat: 0, maxPayAmountMsat: 1000000 },
    { receiveAmountMsat: 1001, maxPayAmountMsat: 2000 },
    { receiveAmountMsat: 2000, maxPayAmountMsat: 1000 },
    { receiveAmountMsat: "1000", maxPayAmountMsat: 2000 },
    { receiveAmountMsat: 1000, maxPayAmountMsat: 100000001 },
  ])("rejects invalid net receive bounds before asking a solver: %j", async (body) => {
    const creator = new FakeCreator("ad".repeat(32));
    ctx = await start(repos, creator, new MemorySettlementStore(60_000));
    await req(`${ctx.baseUrl}/lnurl/address/off/arkade`, "POST", "domain.com", { arkadeAddress: RECEIVE, claimPublicKey: CLAIM_PUBKEY }, TOKEN);
    const response = await req(`${ctx.baseUrl}/.well-known/lnurlp/off/invoice`, "POST", "domain.com", body);
    expect(response.body.status).toBe("ERROR");
    expect(creator.created).toHaveLength(0);
  });

  it("does not persist a net request when the invoice exceeds the payer ceiling", async () => {
    const hash = "ae".repeat(32);
    const store = new MemorySettlementStore(60_000);
    ctx = await start(repos, new FakeCreator(hash), store);
    await req(`${ctx.baseUrl}/lnurl/address/off/arkade`, "POST", "domain.com", { arkadeAddress: RECEIVE, claimPublicKey: CLAIM_PUBKEY }, TOKEN);
    const response = await req(`${ctx.baseUrl}/.well-known/lnurlp/off/invoice`, "POST", "domain.com", { receiveAmountMsat: 1000000, maxPayAmountMsat: 1000000 });
    expect(response.body.status).toBe("ERROR");
    expect(store.get(hash)).toBeUndefined();
  });

  it.each([1000.5, 1000.0001])("rejects a %s-sat invoice rather than rounding it down to the payer ceiling", async (invoiceSats) => {
    const hash = "cf".repeat(32);
    const creator = new FakeCreator(hash);
    const create = creator.create.bind(creator);
    creator.create = async (params) => ({ ...await create(params), invoice: buildInvoice(hash, invoiceSats) });
    const store = new MemorySettlementStore(60_000);
    ctx = await start(repos, creator, store);
    repos.addresses.setOfflineReceive(addressId, RECEIVE, CLAIM_PUBKEY);
    const response = await req(`${ctx.baseUrl}/.well-known/lnurlp/off/invoice`, "POST", "domain.com", { receiveAmountMsat: 1000000, maxPayAmountMsat: 1000000 });
    expect(response.body.status).toBe("ERROR");
    expect(creator.release).toHaveBeenCalledExactlyOnceWith("swap-1");
    expect(store.get(hash)).toBeUndefined();
  });

  it.each(["decode", "persistence"])("releases an unaccepted swap after a %s failure", async (failure) => {
    const hash = "be".repeat(32);
    const creator = new FakeCreator(hash);
    const store = new MemorySettlementStore(60_000);
    if (failure === "decode") {
      const create = creator.create.bind(creator);
      creator.create = async (params) => ({ ...await create(params), invoice: "not-a-bolt11" });
    } else {
      vi.spyOn(store, "create").mockImplementation(() => { throw new Error("storage unavailable"); });
    }
    ctx = await start(repos, creator, store);
    repos.addresses.setOfflineReceive(addressId, RECEIVE, CLAIM_PUBKEY);
    const response = await req(`${ctx.baseUrl}/.well-known/lnurlp/off/invoice`, "POST", "domain.com", { receiveAmountMsat: 1000000, maxPayAmountMsat: 1050000 });
    expect(response.body.status).toBe("ERROR");
    expect(creator.release).toHaveBeenCalledExactlyOnceWith("swap-1");
    expect(store.get(hash)).toBeUndefined();
  });

  it.each([
    { net: 999, cap: 1001, accepted: true, calls: 1 },
    { net: 998, cap: 1000, accepted: false, calls: 1 },
    { net: 998, cap: 999, accepted: false, calls: 0 },
  ])("applies payer bounds to the invoice rather than the net target: %j", async ({ net, cap, accepted, calls }) => {
    const hash = "bf".repeat(32);
    const creator = new FakeCreator(hash);
    const store = new MemorySettlementStore(60_000);
    db.prepare("UPDATE domains SET min_sendable = ?").run(1000000);
    ctx = await start(repos, creator, store);
    repos.addresses.setOfflineReceive(addressId, RECEIVE, CLAIM_PUBKEY);
    const response = await req(`${ctx.baseUrl}/.well-known/lnurlp/off/invoice`, "POST", "domain.com", { receiveAmountMsat: net * 1000, maxPayAmountMsat: cap * 1000 });
    expect(creator.created).toHaveLength(calls);
    if (accepted) {
      expect(response.body).toMatchObject({ paymentQuote: { receive: { amount: "999000", unit: "msat" }, payment: { amount: "1000000", unit: "msat" } } });
      expect(store.get(hash)?.amountMsat).toBe(1000000);
    } else {
      expect(response.body.status).toBe("ERROR");
      expect(store.get(hash)).toBeUndefined();
      expect(creator.release).toHaveBeenCalledTimes(calls);
    }
    const ordinary = await req(`${ctx.baseUrl}/.well-known/lnurlp/off/callback?amount=999000`, "GET", "domain.com");
    expect(ordinary.body.status).toBe("ERROR");
    expect(creator.created).toHaveLength(calls);
  });

  it("honors address rail policy for net requests", async () => {
    const creator = new FakeCreator("af".repeat(32));
    ctx = await start(repos, creator, new MemorySettlementStore(60_000));
    await req(`${ctx.baseUrl}/lnurl/address/off/arkade`, "POST", "domain.com", { arkadeAddress: RECEIVE, claimPublicKey: CLAIM_PUBKEY }, TOKEN);
    db.prepare("UPDATE addresses SET disabled_rails = ? WHERE id = ?").run(JSON.stringify(["offline-swap"]), addressId);
    const response = await req(`${ctx.baseUrl}/.well-known/lnurlp/off/invoice`, "POST", "domain.com", { receiveAmountMsat: 1000000, maxPayAmountMsat: 1050000 });
    expect(response.body).toMatchObject({ status: "ERROR", reason: "offline receive is disabled for this address" });
    expect(creator.created).toHaveLength(0);
  });

  it("supports a nameless receiver without provisioning its owner token to the requester", async () => {
    ctx = await start(repos, new FakeCreator("ba".repeat(32)), new MemorySettlementStore(60_000));
    const token = "bc".repeat(32);
    const registered = await req(`${ctx.baseUrl}/lnurl/address`, "POST", "domain.com", { token, nameless: true });
    expect(registered.status).toBe(201);
    const handle = registered.body.handle;
    await req(`${ctx.baseUrl}/lnurl/address/${handle}/arkade`, "POST", "domain.com", { arkadeAddress: RECEIVE, claimPublicKey: CLAIM_PUBKEY }, token);
    const result = await req(`${ctx.baseUrl}/lnurl/${handle}/invoice`, "POST", "domain.com", { receiveAmountMsat: 1000000, maxPayAmountMsat: 1050000 });
    expect(result.body).toMatchObject({ paymentQuote: { receive: { amount: "1000000", unit: "msat" } } });
  });

  it("still errors offline when no arkade identity is configured", async () => {
    const creator = new FakeCreator("aa".repeat(32));
    ctx = await start(repos, creator, new MemorySettlementStore(60_000));
    // address has no arkade identity set
    const res = await req(`${ctx.baseUrl}/.well-known/lnurlp/off/callback?amount=50000`, "GET", "domain.com");
    expect(res.body.status).toBe("ERROR");
    expect(String(res.body.reason)).toMatch(/offline/i);
    expect(creator.created).toHaveLength(0);
  });

  it("rejects sub-satoshi amounts rather than truncating them", async () => {
    const creator = new FakeCreator("9a".repeat(32));
    repos.addresses.setOfflineReceive(addressId, RECEIVE, CLAIM_PUBKEY);
    ctx = await start(repos, creator, new MemorySettlementStore(60_000));
    const res = await req(`${ctx.baseUrl}/.well-known/lnurlp/off/callback?amount=50001`, "GET", "domain.com");
    expect(res.body.status).toBe("ERROR");
    expect(String(res.body.reason)).toMatch(/whole number of satoshis/i);
    expect(creator.created).toHaveLength(0);
  });

  it("does not consume quote capacity for rejected sub-satoshi amounts", async () => {
    const creator = new FakeCreator("9a".repeat(32));
    repos.addresses.setOfflineReceive(addressId, RECEIVE, CLAIM_PUBKEY);
    ctx = await start(repos, creator, new MemorySettlementStore(60_000));
    for (let i = 0; i < 20; i++) {
      const rejected = await req(`${ctx.baseUrl}/.well-known/lnurlp/off/callback?amount=50001`, "GET", "domain.com");
      expect(rejected.body.status).toBe("ERROR");
    }
    const accepted = await req(`${ctx.baseUrl}/.well-known/lnurlp/off/callback?amount=50000`, "GET", "domain.com");
    expect(accepted.body.pr).toBeDefined();
    expect(creator.created).toHaveLength(1);
  });

  // An arbitrary failure may name a solver or this server's wiring, so it stays generic.
  it("returns an LNURL error when swap creation fails", async () => {
    const creator: OfflineSwapCreator = {
      create: async () => { throw new Error("all solver candidates failed: acme: nostr relay refused"); },
      isSettled: async () => false,
    };
    repos.addresses.setOfflineReceive(addressId, RECEIVE, CLAIM_PUBKEY);
    ctx = await start(repos, creator, new MemorySettlementStore(60_000));
    const res = await req(`${ctx.baseUrl}/.well-known/lnurlp/off/callback?amount=50000`, "GET", "domain.com");
    expect(res.body.status).toBe("ERROR");
    expect(String(res.body.reason)).toBe("Unable to create offline invoice");
    expect(String(res.body.reason)).not.toContain("acme");
    // nothing recorded: no verify URL exists for a swap that was never created
  });

  // Actionable and safe: names the amount, not a solver. LUD-06 shape, HTTP 200.
  it("tells the payer why a refused amount was refused", async () => {
    const creator: OfflineSwapCreator = {
      create: async () => { throw new RailRefusedError("no solver card supports a 50 sat lightning receive"); },
      isSettled: async () => false,
    };
    repos.addresses.setOfflineReceive(addressId, RECEIVE, CLAIM_PUBKEY);
    ctx = await start(repos, creator, new MemorySettlementStore(60_000));
    const res = await req(`${ctx.baseUrl}/.well-known/lnurlp/off/callback?amount=50000`, "GET", "domain.com");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ERROR");
    expect(String(res.body.reason)).toBe("no solver card supports a 50 sat lightning receive");
  });

  it("rate-limits the offline-swap callback per IP", async () => {
    const creator = new FakeCreator("9a".repeat(32));
    repos.addresses.setOfflineReceive(addressId, RECEIVE, CLAIM_PUBKEY);
    ctx = await start(repos, creator, new MemorySettlementStore(60_000));
    let last = { status: 0, body: {} as Record<string, unknown> };
    for (let i = 0; i < 30; i++) {
      last = await req(`${ctx.baseUrl}/.well-known/lnurlp/off/callback?amount=50000`, "GET", "domain.com");
      expect(last.body.pr).toBeDefined();
    }
    last = await req(`${ctx.baseUrl}/.well-known/lnurlp/off/callback?amount=50000`, "GET", "domain.com");
    expect(last.status).toBe(429);
    expect(creator.created).toHaveLength(30);
  });

  it("rate-limits net invoice POSTs before creating a swap and shares the callback budget", async () => {
    const creator = new FakeCreator("cd".repeat(32));
    repos.addresses.setOfflineReceive(addressId, RECEIVE, CLAIM_PUBKEY);
    ctx = await start(repos, creator, new MemorySettlementStore(60_000));
    const url = `${ctx.baseUrl}/.well-known/lnurlp/off/invoice`;
    const body = { receiveAmountMsat: 1000000, maxPayAmountMsat: 1050000 };
    for (let i = 0; i < 30; i++) {
      const response = await req(url, "POST", "domain.com", body);
      expect(response.body.pr).toBeDefined();
    }
    const blocked = await req(url, "POST", "domain.com", body);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ status: "ERROR", reason: "Too many requests" });
    const callback = await req(`${ctx.baseUrl}/.well-known/lnurlp/off/callback?amount=1000000`, "GET", "domain.com");
    expect(callback.status).toBe(429);
    expect(creator.created).toHaveLength(30);
  });

  it("rejects a malformed claimPublicKey or arkadeAddress at registration", async () => {
    ctx = await start(repos);
    const badKey = await req(`${ctx.baseUrl}/lnurl/address/off/arkade`, "POST", "domain.com", { arkadeAddress: RECEIVE, claimPublicKey: "04" + "ab".repeat(32) }, TOKEN);
    expect(badKey.status).toBe(400);
    const badAddr = await req(`${ctx.baseUrl}/lnurl/address/off/arkade`, "POST", "domain.com", { arkadeAddress: "tark1qreceiver", claimPublicKey: CLAIM_PUBKEY }, TOKEN);
    expect(badAddr.status).toBe(400);
    expect(repos.addresses.getById(addressId)!.arkadeAddress).toBeNull();
  });

  it("answers an hd-only registration with the static identity error", async () => {
    ctx = await start(repos);
    const hd = { version: 1, descriptor: "tr([abcdef12/86'/1'/7'/0]tpubD/*)", serverPubKey: "ab".repeat(32), hrp: "tark", exitDelay: { type: "seconds", value: 1024 } };
    const res = await req(`${ctx.baseUrl}/lnurl/address/off/arkade`, "POST", "domain.com", { hd }, TOKEN);
    expect(res).toEqual({ status: 400, body: { error: "arkadeAddress and a compressed-hex claimPublicKey (02/03 + 64 hex) are required" } });
    expect(repos.addresses.getById(addressId)!.arkadeAddress).toBeNull();
  });

  it("rejects arkade identity registration on a revoked address", async () => {
    ctx = await start(repos);
    repos.addresses.updateStatus(addressId, "revoked");
    const res = await req(`${ctx.baseUrl}/lnurl/address/off/arkade`, "POST", "domain.com", { arkadeAddress: RECEIVE, claimPublicKey: CLAIM_PUBKEY }, TOKEN);
    expect(res.status).toBe(404);
  });
});
