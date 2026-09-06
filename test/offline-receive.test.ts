import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { bech32 } from "@scure/base";
import { ArkAddress } from "@arkade-os/sdk";
import { createServer } from "../src/server.js";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { AddressService } from "../src/address-service.js";
import { MemorySettlementStore } from "../src/settlement-store.js";
import { encryptToken } from "../src/crypto.js";
import { deriveSessionId } from "../src/session-id.js";
import type { OfflineSwapCreator, OfflineSwapParams, OfflineSwapResult } from "../src/intent-swap.js";
import type { LnurlServiceConfig } from "../src/types.js";

const KEY = randomBytes(32);
const CONFIG: LnurlServiceConfig = { port: 0, baseUrl: "", minSendable: 1000, maxSendable: 100_000_000, invoiceTimeoutMs: 3000 };
const TOKEN = "cd".repeat(32);
const RECEIVE = new ArkAddress(new Uint8Array(32), new Uint8Array(32), "tark").encode();
const CLAIM_PUBKEY = "02" + "ab".repeat(32);

function buildInvoice(paymentHashHex: string): string {
  const words: number[] = [];
  for (let i = 0; i < 7; i++) words.push(0);
  const hw = bech32.toWords(Uint8Array.from(Buffer.from(paymentHashHex, "hex")));
  words.push(1, 52 >> 5, 52 & 31, ...hw);
  for (let i = 0; i < 104; i++) words.push(0);
  return bech32.encode("lnbc", words, 2000);
}

/** Deterministic in-memory offline-swap creator for tests. */
class FakeCreator implements OfflineSwapCreator {
  created: OfflineSwapParams[] = [];
  settledIds = new Set<string>();
  constructor(private hashHex: string) {}
  async create(params: OfflineSwapParams): Promise<OfflineSwapResult> {
    this.created.push(params);
    return {
      swapId: "swap-1",
      invoice: buildInvoice(this.hashHex),
      preimage: "11".repeat(32),
      preimageHash: this.hashHex,
      lockupAddress: RECEIVE,
    };
  }
  async isSettled(swapId: string): Promise<boolean> {
    return this.settledIds.has(swapId);
  }
}

function start(repos: Repositories, creator?: OfflineSwapCreator, settlements?: MemorySettlementStore) {
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
          { repos, addressService, settlements, offlineSwapCreator: creator },
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
  const domainId = repos.domains.create({ domain: "domain.com", allocationModes: ["self"] }).id;
  addressId = repos.addresses.create({
    domainId, username: "off", status: "active",
    sessionId: deriveSessionId(TOKEN), encryptedToken: encryptToken(TOKEN, KEY),
  }).id;
});
afterEach(async () => { await ctx.close(); db.close(); });

describe("offline receive", () => {
  it("registers an arkade receive identity via POST /lnurl/address/:username/arkade", async () => {
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
    const settlements = new MemorySettlementStore(60_000);
    repos.addresses.setOfflineReceive(addressId, RECEIVE, CLAIM_PUBKEY);
    ctx = await start(repos, creator, settlements);

    const res = await req(`${ctx.baseUrl}/.well-known/lnurlp/off/callback?amount=50000`, "GET", "domain.com");
    expect(res.body.pr).toBe(buildInvoice(hash));
    expect(res.body.verify).toBe(`${ctx.baseUrl}/lnurl/verify/${hash}`);
    // amount converted msat -> sat, and the user's identity forwarded
    expect(creator.created[0]).toEqual({ amountSat: 50, receiveAddress: RECEIVE, claimPublicKey: CLAIM_PUBKEY });

    // verify is registered but not yet settled (poller hasn't run)
    const v = await req(`${ctx.baseUrl}/lnurl/verify/${hash}`, "GET", "domain.com");
    expect(v.body).toMatchObject({ status: "OK", settled: false, preimage: null });
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

  it("returns an LNURL error when swap creation fails", async () => {
    const creator: OfflineSwapCreator = {
      create: async () => { throw new Error("solver refused: amount_out_of_range"); },
      isSettled: async () => false,
    };
    repos.addresses.setOfflineReceive(addressId, RECEIVE, CLAIM_PUBKEY);
    ctx = await start(repos, creator, new MemorySettlementStore(60_000));
    const res = await req(`${ctx.baseUrl}/.well-known/lnurlp/off/callback?amount=50000`, "GET", "domain.com");
    expect(res.body.status).toBe("ERROR");
    expect(String(res.body.reason)).toMatch(/amount_out_of_range/);
    // nothing recorded: no verify URL exists for a swap that was never created
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

  it("rejects a malformed claimPublicKey or arkadeAddress at registration", async () => {
    ctx = await start(repos);
    const badKey = await req(`${ctx.baseUrl}/lnurl/address/off/arkade`, "POST", "domain.com", { arkadeAddress: RECEIVE, claimPublicKey: "04" + "ab".repeat(32) }, TOKEN);
    expect(badKey.status).toBe(400);
    const badAddr = await req(`${ctx.baseUrl}/lnurl/address/off/arkade`, "POST", "domain.com", { arkadeAddress: "tark1qreceiver", claimPublicKey: CLAIM_PUBKEY }, TOKEN);
    expect(badAddr.status).toBe(400);
    expect(repos.addresses.getById(addressId)!.arkadeAddress).toBeNull();
  });

  it("rejects arkade identity registration on a revoked address", async () => {
    ctx = await start(repos);
    repos.addresses.updateStatus(addressId, "revoked");
    const res = await req(`${ctx.baseUrl}/lnurl/address/off/arkade`, "POST", "domain.com", { arkadeAddress: RECEIVE, claimPublicKey: CLAIM_PUBKEY }, TOKEN);
    expect(res.status).toBe(404);
  });
});
