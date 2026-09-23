import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { randomBytes } from "node:crypto";
import type { Response } from "express";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ArkAddress } from "@arkade-os/sdk";
import { createServer, type ServerDeps } from "../src/server.js";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { AddressService } from "../src/address-service.js";
import { OwnerSetupService } from "../src/owner-setup-service.js";
import { SessionManager } from "../src/session-manager.js";
import { deriveSessionId } from "../src/session-id.js";
import { MemorySettlementStore } from "../src/settlement-store.js";
import { encodeOwnerSetup, ownerSetupDigest, type OwnerSetup } from "../src/enclave/owner-setup.js";
import type { OfflineSwapCreator } from "../src/intent-swap.js";
import type { CovenantDestinationProvider } from "../src/covenant-destination.js";
import type { LnurlServiceConfig } from "../src/types.js";

const CONFIG: LnurlServiceConfig = { port: 0, baseUrl: "", minSendable: 1000, maxSendable: 100_000_000, invoiceTimeoutMs: 3000 };
const HOST = "wallet.example";
const ownerKey = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const destination = (n: number) => new ArkAddress(new Uint8Array(32).fill(2), new Uint8Array(32).fill(n), "tark").encode();
const ATTACKER = { arkadeAddress: destination(9), claimPublicKey: "02" + "ee".repeat(32) };

const SETUP: OwnerSetup = {
  intent: "set", deployment: "lnurl-test", tenant: HOST, network: "regtest", domain: HOST, username: "alice",
  ownerPublicKey: bytesToHex(schnorr.getPublicKey(ownerKey)), arkadeDestination: destination(3),
  claimPublicKey: "02" + "ab".repeat(32), rails: ["offline-swap", "arkade", "covenant"], revision: 1,
};
const signed = (s: OwnerSetup) => ({ payload: encodeOwnerSetup(s), signature: schnorr.sign(ownerSetupDigest(s), ownerKey) });

let db: Db; let repos: Repositories; let owners: OwnerSetupService; let sessions: SessionManager;
let settlements: MemorySettlementStore; let server: http.Server | undefined; let baseUrl: string;
let quotes: { receiveAddress: string; claimPublicKey: string }[]; let derivations: { arkadeAddress: string; claimPublicKey: string }[];
let invoiceRequests: number; let issued: string[];

const swapCreator: OfflineSwapCreator = {
  create: async (req) => {
    quotes.push({ receiveAddress: req.receiveAddress, claimPublicKey: req.claimPublicKey });
    return { swapId: "swap-1", invoice: "lnbc1offline", preimage: "ab".repeat(32), preimageHash: randomBytes(32).toString("hex"), lockupAddress: "tark1lockup", recovery: { version: 1, solverName: "fake", solverPubkey: "11".repeat(32), relays: [], rfqId: "swap-1", lockupAddress: "tark1lockup", expectedAmount: 50, script: {} } };
  },
  isSettled: async () => false,
};
const covenants: CovenantDestinationProvider = {
  derive: async (address) => { derivations.push(address); return { address: "tark1covenant", script: randomBytes(34).toString("hex") }; },
};

beforeEach(() => {
  db = openDb(":memory:"); runMigrations(db); repos = createRepositories(db);
  repos.domains.create({ domain: HOST, allocationModes: ["self"] });
  owners = new OwnerSetupService(repos, new AddressService(repos, randomBytes(32)), { deployment: "lnurl-test", network: "regtest", enrollment: true });
  sessions = new SessionManager();
  sessions.requestInvoice = async () => { invoiceRequests++; return "lnbc1substituted"; };
  settlements = new MemorySettlementStore(86_400_000);
  quotes = []; derivations = []; invoiceRequests = 0; issued = [];
});
afterEach(async () => {
  if (server) await new Promise<void>((r) => { server!.closeAllConnections(); server!.close(() => r()); });
  server = undefined;
  db.close();
});

async function serve(extra: Partial<ServerDeps> = {}): Promise<void> {
  server = http.createServer();
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  server.on("request", createServer({ ...CONFIG, baseUrl }, {
    repos, sessions, settlements, offlineSwapCreator: swapCreator, covenantDestinations: covenants,
    solverDiscovery: { status: () => ({ ready: true }) }, onDestinationIssued: (d) => issued.push(d), ...extra,
  }));
}

function get(path: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}${path}`, { headers: { Host: HOST } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(JSON.parse(body)));
    }).on("error", reject);
  });
}

function post(path: string, body: unknown, bearer?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${path}`, {
      method: "POST", headers: { Host: HOST, "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    }, (res) => { resolve(res.statusCode!); res.destroy(); });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

function enroll(setup = SETUP): { token: string; addressId: number } {
  const token = randomBytes(32).toString("hex");
  const out = owners.submit({ ...signed(setup), token });
  return { token, addressId: out.identity.addressId! };
}

const liveSession = (token: string) => sessions.create({ on: () => undefined, write: () => true } as unknown as Response, token);

describe("receiving on a protected address", () => {
  it("routes a protected callback from the committed setup, not the row", async () => {
    const { addressId } = enroll();
    repos.addresses.setOfflineReceive(addressId, ATTACKER.arkadeAddress, ATTACKER.claimPublicKey);
    await serve();

    expect(await get("/.well-known/lnurlp/alice/callback?amount=50000")).toMatchObject({ pr: "lnbc1offline" });
    expect(await get("/.well-known/lnurlp/alice/callback?amount=50000&paymentOption=arkade")).toMatchObject({ status: "OK", paymentDestination: "tark1covenant" });
    const owner = { receiveAddress: SETUP.arkadeDestination, claimPublicKey: SETUP.claimPublicKey };
    expect(quotes).toEqual([owner]);
    expect(derivations).toEqual([{ arkadeAddress: SETUP.arkadeDestination, claimPublicKey: SETUP.claimPublicKey }]);
  });

  it("ignores a live session on a protected address", async () => {
    const { token, addressId } = enroll();
    repos.addresses.setDisabledRails(addressId, []);
    expect(liveSession(token)).not.toBeNull();
    await serve();

    expect(await get("/.well-known/lnurlp/alice/callback?amount=50000")).toMatchObject({ pr: "lnbc1offline" });
    expect(invoiceRequests).toBe(0);
  });

  it("refuses a legacy token opening a session for a protected address", async () => {
    const { token } = enroll();
    const legacyToken = randomBytes(32).toString("hex");
    new AddressService(repos, randomBytes(32)).register({ domain: repos.domains.getByDomain(HOST)!, username: "carol", token: legacyToken });
    await serve();

    expect(await post("/lnurl/session", { token })).toBe(409);
    expect(sessions.isActive(deriveSessionId(token))).toBe(false);
    expect(await post(`/lnurl/session/${deriveSessionId(token)}/invoice`, { pr: "lnbc1substituted" }, token)).toBe(401);
    expect(await get("/.well-known/lnurlp/alice/callback?amount=50000")).toMatchObject({ pr: "lnbc1offline" });
    expect(await post("/lnurl/session", { token: legacyToken })).toBe(200);
  });

  it("refuses explicitly when a protected rail is unavailable, never falling back to a session", async () => {
    const { token, addressId } = enroll();
    repos.addresses.setDisabledRails(addressId, []);
    liveSession(token);
    await serve({ solverDiscovery: { status: () => ({ ready: false, reason: "no cards" }) } });
    expect(await get("/.well-known/lnurlp/alice/callback?amount=50000")).toEqual({ status: "ERROR", reason: "offline receive unavailable: no cards" });

    await new Promise<void>((r) => { server!.closeAllConnections(); server!.close(() => r()); });
    await serve({ offlineSwapCreator: undefined });
    expect(await get("/.well-known/lnurlp/alice/callback?amount=50000")).toEqual({
      status: "ERROR", reason: "lightning receive is unavailable for this address: offline receive is not configured",
    });
    expect(invoiceRequests).toBe(0);
  });

  it("advertises only the owner's rails", async () => {
    const { addressId } = enroll({ ...SETUP, rails: ["arkade"], boardingAddress: "tb1qowner" });
    repos.addresses.setDisabledRails(addressId, []);
    await serve();

    expect((await get("/.well-known/lnurlp/alice")).paymentOptions).toEqual([{ id: "arkade", type: "arkade" }]);
    expect(await get("/.well-known/lnurlp/alice/callback?amount=50000")).toEqual({ status: "ERROR", reason: "offline receive is disabled for this address" });
    expect(await get("/.well-known/lnurlp/alice/callback?amount=50000&paymentOption=onchain")).toEqual({ status: "ERROR", reason: "paymentOption onchain is disabled for this address" });
    expect(await get("/.well-known/lnurlp/alice/callback?amount=50000&paymentOption=arkade")).toMatchObject({ status: "OK", paymentDestination: SETUP.arkadeDestination });
    expect(issued).toEqual([SETUP.arkadeDestination]);
  });

  it("records a protected destination under addr:<id>, not the session id", async () => {
    const { addressId } = enroll({ ...SETUP, rails: ["arkade"] });
    await serve();

    await get("/.well-known/lnurlp/alice/callback?amount=50000&paymentOption=arkade");
    expect(settlements.listByAddress(addressId, 10).map((r) => r.sessionId)).toEqual([`addr:${addressId}`]);
  });

  it("answers a revoked identity and a suspended one with distinct explicit reasons", async () => {
    enroll();
    owners.submit(signed({ ...SETUP, intent: "revoke", revision: 2, previousHash: bytesToHex(ownerSetupDigest(SETUP)) }));
    enroll({ ...SETUP, username: "bob" });
    repos.ownerSetups.suspend(HOST, "bob", "chargeback review");
    await serve();

    const revoked = { status: "ERROR", reason: "alice@wallet.example was revoked by its owner" };
    expect(await get("/.well-known/lnurlp/alice")).toEqual(revoked);
    expect(await get("/.well-known/lnurlp/alice/callback?amount=50000")).toEqual(revoked);
    const suspended = { status: "ERROR", reason: "bob@wallet.example is suspended by its provider" };
    expect(await get("/.well-known/lnurlp/bob")).toEqual(suspended);
    expect(await get("/.well-known/lnurlp/bob/callback?amount=50000")).toEqual(suspended);
    expect(quotes).toEqual([]);

    repos.ownerSetups.suspend(HOST, "bob", null);
    expect(await get("/.well-known/lnurlp/bob")).toMatchObject({ tag: "payRequest" });
  });

  it("routes nothing through a row its identity does not claim", async () => {
    const { addressId } = enroll();
    repos.addresses.delete(addressId);
    const impostor = repos.addresses.create({ domainId: repos.domains.getByDomain(HOST)!.id, username: "alice", status: "active", sessionId: "sess-impostor" });
    repos.addresses.setOfflineReceive(impostor.id, ATTACKER.arkadeAddress, ATTACKER.claimPublicKey);
    await serve();

    expect(await get("/.well-known/lnurlp/alice")).toEqual({ status: "ERROR", reason: "Unknown LN address" });
    expect(await get("/.well-known/lnurlp/alice/callback?amount=50000&paymentOption=arkade")).toEqual({ status: "ERROR", reason: "Unknown LN address" });
    expect(quotes).toEqual([]);
    expect(settlements.listByAddress(impostor.id, 10)).toEqual([]);
  });

  it("leaves a legacy address on its row and its live session", async () => {
    const token = randomBytes(32).toString("hex");
    const legacy = new AddressService(repos, randomBytes(32)).register({ domain: repos.domains.getByDomain(HOST)!, username: "carol", token });
    repos.addresses.setOfflineReceive(legacy.address.id, ATTACKER.arkadeAddress, ATTACKER.claimPublicKey);
    liveSession(token);
    await serve();

    expect(await get("/.well-known/lnurlp/carol/callback?amount=50000")).toMatchObject({ pr: "lnbc1substituted" });
    expect(invoiceRequests).toBe(1);
  });
});
