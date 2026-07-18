import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { bech32 } from "@scure/base";
import { createServer } from "../src/server.js";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { AddressService } from "../src/address-service.js";
import { MemorySettlementStore } from "../src/settlement-store.js";
import { encryptToken } from "../src/crypto.js";
import { deriveSessionId } from "../src/session-id.js";
import type { ReverseSwapCreator, ReverseSwapParams, ReverseSwapResult } from "../src/reverse-swap.js";
import type { LnurlServiceConfig } from "../src/types.js";

const KEY = randomBytes(32);
const CONFIG: LnurlServiceConfig = { port: 0, baseUrl: "", minSendable: 1000, maxSendable: 100_000_000, invoiceTimeoutMs: 3000 };
const TOKEN = "cd".repeat(32);
const RECEIVE = "tark1qreceiver";
const CLAIM_PUBKEY = "02" + "ab".repeat(32);

function buildInvoice(paymentHashHex: string): string {
  const words: number[] = [];
  for (let i = 0; i < 7; i++) words.push(0);
  const hw = bech32.toWords(Uint8Array.from(Buffer.from(paymentHashHex, "hex")));
  words.push(1, 52 >> 5, 52 & 31, ...hw);
  for (let i = 0; i < 104; i++) words.push(0);
  return bech32.encode("lnbc", words, 2000);
}

/** Deterministic in-memory reverse-swap creator for tests. */
class FakeCreator implements ReverseSwapCreator {
  created: ReverseSwapParams[] = [];
  settledIds = new Set<string>();
  constructor(private hashHex: string) {}
  async create(params: ReverseSwapParams): Promise<ReverseSwapResult> {
    this.created.push(params);
    return {
      swapId: "swap-1",
      invoice: buildInvoice(this.hashHex),
      preimage: "11".repeat(32),
      preimageHash: this.hashHex,
      lockupAddress: "tark1qlockup",
    };
  }
  async isSettled(swapId: string): Promise<boolean> {
    return this.settledIds.has(swapId);
  }
}

function start(repos: Repositories, creator?: ReverseSwapCreator, settlements?: MemorySettlementStore) {
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
          { repos, addressService, settlements, reverseSwapCreator: creator },
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
});
