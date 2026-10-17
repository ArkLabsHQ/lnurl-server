import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { ArkAddress } from "@arkade-os/sdk";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { AddressService } from "../src/services/addresses.js";
import { createServer } from "../src/http/server.js";
import type { ServerDeps } from "../src/http/server-context.js";
import { deriveSessionId } from "../src/session-token.js";
import { encryptToken } from "../src/crypto.js";
import { DbSettlementStore, MemorySettlementStore } from "../src/settlement-store.js";
import { OfflineSwapStore } from "../src/offline-swap-store.js";
import { settleDestinationPayments } from "../src/workers/arkade-watcher.js";
import { hex } from "@scure/base";

const TOKEN = "cd".repeat(32), KEY = Buffer.alloc(32, 9);
const HD = {
  version: 1,
  descriptor: "tr([abcdef12/86'/1'/7'/0]tpubDFYduaquYUH6D8bfpBZZtfWTtYBuzFiayqJzphZu8RHs7TAVPar4BpL585fBTj3YQLPLVaAoR97PNRZyiddAhSaNCpA4YRap6ktK5hbzTB7/*)",
  serverPubKey: "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  hrp: "tark", exitDelay: { type: "seconds", value: 1024 },
} as const;
let db: Db, repos: Repositories, service: AddressService, addressId: number;
beforeEach(() => {
  db = openDb(":memory:"); runMigrations(db); repos = createRepositories(db); service = new AddressService(repos, KEY);
  const domain = repos.domains.create({ domain: "domain.com", allocationModes: ["self"] });
  addressId = repos.addresses.create({ domainId: domain.id, username: "alice", status: "active", sessionId: deriveSessionId(TOKEN), encryptedToken: encryptToken(TOKEN, KEY) }).id;
});
afterEach(() => db.close());
const app = (deps: Partial<ServerDeps> = {}) => createServer(
  { port: 0, baseUrl: "http://domain.com", minSendable: 1000, maxSendable: 100_000_000, invoiceTimeoutMs: 3000 },
  { repos, addressService: service, ...deps },
);
const register = (server: ReturnType<typeof app>, body: object = { hd: HD }) => request(server).post("/lnurl/address/alice/arkade").set("Host", "domain.com").auth(TOKEN, { type: "bearer" }).send(body);
const callback = (server: ReturnType<typeof app>, option = "arkade") => request(server).get(`/.well-known/lnurlp/alice/callback?amount=500000&paymentOption=${option}`).set("Host", "domain.com");

describe("HD LNURL receive", () => {
  it("acknowledges HD registration and allocates different direct destinations for equal payments", async () => {
    const server = app({ arkServerUrl: "http://indexer.invalid" });
    expect((await register(server)).body).toMatchObject({ ok: true, receiveMode: "hd" });
    const [a, b] = await Promise.all([callback(server), callback(server)]);
    expect(a.body.paymentDestination).toMatch(/^tark1/);
    expect(b.body.paymentDestination).not.toBe(a.body.paymentDestination);
    expect(a.body.verify).toContain("/lnurl/verify/");
    const saved = repos.addresses.getById(addressId)!;
    expect(saved.arkadeAddress).toBeNull();
    expect(saved.claimPublicKey).toBeNull();
  });

  it("never downgrades an HD receiver when an old client re-registers a static address", async () => {
    const server = app(); await register(server);
    const address = new ArkAddress(new Uint8Array(32), new Uint8Array(32), "tark").encode();
    expect((await register(server, { arkadeAddress: address, claimPublicKey: "02" + "ab".repeat(32) })).status).toBe(400);
    expect((await callback(server)).body.paymentDestination).toMatch(/^tark1/);
  });

  it("refuses mixed static and HD registration without changing the receiver", async () => {
    const server = app();
    expect((await register(server, { hd: HD, arkadeAddress: "static", claimPublicKey: "key" })).status).toBe(400);
    expect(repos.addresses.getById(addressId)!.arkadeAddress).toBeNull();
  });

  it("logs allocation failures while keeping internal details out of the payer response", async () => {
    const error = vi.fn();
    const server = app({ logger: { info: vi.fn(), warn: vi.fn(), error } });
    await register(server); await callback(server);
    db.exec("UPDATE hd_receive_sources SET next_index = 0");
    const result = await callback(server);
    expect(result.body).toMatchObject({ status: "ERROR", reason: "HD receive destination is unavailable" });
    expect(result.body.paymentDestination).toBeUndefined();
    expect(error).toHaveBeenCalledWith("hd_receive_allocation_failed", { addressId, error: expect.any(Error) });
    expect((error.mock.calls[0]![1].error as Error).message).toContain("counter is inconsistent");
  });

  it("refuses a disabled HD Arkade rail before reserving an allocation", async () => {
    const server = app(); await register(server);
    repos.addresses.setDisabledRails(addressId, ["arkade"]);
    expect((await callback(server)).body.reason).toContain("arkade is disabled");
    expect(repos.hdReceive.list(addressId, 0, 100)).toEqual([]);
  });

  it("refuses instead of falling back when covenant derivation fails", async () => {
    const derive = vi.fn().mockRejectedValue(new Error("emulator unavailable"));
    const server = app({ covenantDestinations: { derive } });
    await register(server);
    const result = await callback(server);
    expect(result.body.status).toBe("ERROR");
    expect(result.body.paymentDestination).toBeUndefined();
    expect(derive).toHaveBeenCalledOnce();
    const allocations = await request(server).get("/lnurl/address/alice/arkade/allocations").set("Host", "domain.com").auth(TOKEN, { type: "bearer" });
    expect(allocations.body.allocations).toHaveLength(1);
  });

  it("uses fresh payout keys for offline Lightning invoices, including failed attempts", async () => {
    const create = vi.fn().mockRejectedValue(new Error("quote unavailable"));
    const server = app({ offlineSwapCreator: { create, isSettled: async () => false } });
    await register(server);
    await callback(server, "lightning"); await callback(server, "lightning");
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]![0].receiveAddress).not.toBe(create.mock.calls[1]![0].receiveAddress);
    expect(create.mock.calls[0]![0].claimPublicKey).not.toBe(create.mock.calls[1]![0].claimPublicKey);
    const page = await request(server).get("/lnurl/address/alice/arkade/allocations?limit=1").set("Host", "domain.com").auth(TOKEN, { type: "bearer" });
    expect(page.body.allocations).toHaveLength(1);
    const next = await request(server).get(`/lnurl/address/alice/arkade/allocations?after=${page.body.nextAfter}`).set("Host", "domain.com").auth(TOKEN, { type: "bearer" });
    expect(next.body.allocations).toHaveLength(1);
    expect(next.body.allocations[0].index).toBe(1);
  });

  it("retains authenticated recovery access after revocation and refuses other owners", async () => {
    const server = app(); await register(server); await callback(server);
    repos.addresses.updateStatus(addressId, "revoked");
    const url = "/lnurl/address/alice/arkade/allocations";
    expect((await request(server).get(url).set("Host", "domain.com").auth("ab".repeat(32), { type: "bearer" })).status).toBe(404);
    const result = await request(server).get(url).set("Host", "domain.com").auth(TOKEN, { type: "bearer" });
    expect(result.status).toBe(200); expect(result.body.allocations).toHaveLength(1);
  });

  it("recovers a revoked, renamed receiver through its original nameless handle", async () => {
    const server = app(); await register(server); await callback(server);
    db.prepare("UPDATE addresses SET session_lnurl = 1 WHERE id = ?").run(addressId);
    const handle = deriveSessionId(TOKEN);
    repos.addresses.rename(addressId, "renamed");
    repos.addresses.updateStatus(addressId, "revoked");
    const url = `/lnurl/address/${handle}/arkade/allocations`;
    expect((await request(server).get(url).set("Host", "domain.com").auth("ab".repeat(32), { type: "bearer" })).status).toBe(404);
    const result = await request(server).get(url).set("Host", "domain.com").auth(TOKEN, { type: "bearer" });
    expect(result.status).toBe(200); expect(result.body.allocations).toHaveLength(1);
  });

  it("keeps the active receiver reachable when its original handle also has revoked history", async () => {
    const server = app(); await register(server); await callback(server);
    db.prepare("UPDATE addresses SET session_lnurl = 1 WHERE id = ?").run(addressId);
    repos.addresses.updateStatus(addressId, "revoked");
    const previous = repos.addresses.getById(addressId)!;
    const current = repos.addresses.create({ domainId: previous.domainId, username: "current", sessionId: deriveSessionId(TOKEN), status: "active", sessionLnurl: true });
    repos.addresses.setHdReceive(current.id, HD);
    const allocation = repos.hdReceive.allocate(current.id, HD);
    const result = await request(server).get(`/lnurl/address/${deriveSessionId(TOKEN)}/arkade/allocations`).set("Host", "domain.com").auth(TOKEN, { type: "bearer" });
    expect(result.status).toBe(200);
    expect(result.body.allocations.map((a: { id: number }) => a.id)).toEqual([allocation.id]);
  });

  it("keeps the original receive script for an outstanding invoice after registration rotation", async () => {
    const create = vi.fn(async (params: { claimPublicKey: string; receiveAddress: string }) => ({
      swapId: "pending-hd-swap", invoice: "test-invoice", preimage: "11".repeat(32), preimageHash: "22".repeat(32), lockupAddress: params.receiveAddress,
      recovery: { version: 1 as const, solverName: "fake", solverPubkey: "33".repeat(32), relays: ["wss://relay.invalid"], rfqId: "pending-hd-swap", lockupAddress: params.receiveAddress, expectedAmount: 500,
        script: { payoutAddress: params.receiveAddress, receiver: params.claimPublicKey } },
    }));
    const offlineSwaps = new OfflineSwapStore(db, 60_000);
    const server = app({ offlineSwapCreator: { create, isSettled: async () => false }, offlineSwaps, settlements: new DbSettlementStore(db, 60_000) });
    await register(server);
    expect((await callback(server, "lightning")).body.pr).toBe("test-invoice");
    const original = offlineSwaps.listPending()[0]!.recovery;
    await register(server, { hd: { ...HD, exitDelay: { type: "seconds", value: 2048 } } });
    await callback(server);
    expect(offlineSwaps.listPending()[0]!.recovery).toEqual(original);
    const page = await request(server).get("/lnurl/address/alice/arkade/allocations").set("Host", "domain.com").auth(TOKEN, { type: "bearer" });
    expect(page.body.allocations.map((a: { index: number }) => a.index)).toEqual([0, 1]);
    expect(page.body.allocations[0].hd.exitDelay.value).toBe(1024);
    expect(page.body.allocations[1].hd.exitDelay.value).toBe(2048);
    expect(page.body.allocations[0].arkadeAddress).toBe(original.script.payoutAddress);
  });

  it("advertises only rotating receive paths and refuses interactive fallback without a swap service", async () => {
    const server = app({ arkServerUrl: "http://indexer.invalid" }); await register(server);
    const payRequest = await request(server).get("/.well-known/lnurlp/alice").set("Host", "domain.com");
    const options = payRequest.body.paymentOptions as { id: string; verifiable: boolean }[];
    expect(options.find((o) => o.id === "arkade")?.verifiable).toBe(true);
    expect(options.find((o) => o.id === "onchain")).toBeUndefined();
    expect((await callback(server, "onchain")).body.status).toBe("ERROR");
    expect((await callback(server, "lightning")).body.reason).toContain("offline swap service");
  });

  it("does not promise direct payment verification without settlement observation", async () => {
    const server = app(); await register(server);
    const options = (await request(server).get("/.well-known/lnurlp/alice").set("Host", "domain.com")).body.paymentOptions;
    expect(options.find((o: { id: string }) => o.id === "arkade").verifiable).toBe(false);
    expect((await callback(server)).body.verify).toBeUndefined();
  });

  it.each(["memory", "db"])("verifies two HD payouts in one transaction without reusing an output (%s)", async (backend) => {
    const store = backend === "db" ? new DbSettlementStore(db, 60_000) : new MemorySettlementStore(60_000);
    const server = app({ settlements: store, arkServerUrl: "http://indexer.invalid" }); await register(server);
    const a = (await callback(server)).body, b = (await callback(server)).body;
    const txid = "44".repeat(32);
    const vtxos = [a, b].map((payment, vout) => ({ txid, vout, value: 500, createdAt: new Date(), script: hex.encode(ArkAddress.decode(payment.paymentDestination).pkScript) }));
    const indexer = { getVtxos: async () => ({ vtxos }) };
    expect(await settleDestinationPayments(store, indexer as never)).toBe(2);
    expect(store.get(a.verify.split("/").at(-1))?.paymentReference).toBe(txid);
    expect(store.get(b.verify.split("/").at(-1))?.paymentReference).toBe(txid);
    store.create({ paymentHash: "replay", pr: "", sessionId: "test", paymentOption: "arkade", paymentDestination: a.paymentDestination, amountMsat: 500_000 });
    expect(await settleDestinationPayments(store, indexer as never)).toBe(0);
    expect(store.get("replay")?.settled).toBe(false);
  });

  it.each(["memory", "db"])("blocks payment replay through another address encoding of the same script (%s)", async (backend) => {
    const store = backend === "db" ? new DbSettlementStore(db, 60_000) : new MemorySettlementStore(60_000);
    const server = app({ settlements: store }); await register(server);
    const payment = (await callback(server)).body;
    const decoded = ArkAddress.decode(payment.paymentDestination);
    const alias = new ArkAddress(new Uint8Array(32).fill(1), decoded.vtxoTaprootKey, "tark").encode();
    expect(alias).not.toBe(payment.paymentDestination);
    expect(ArkAddress.decode(alias).pkScript).toEqual(decoded.pkScript);
    const indexer = { getVtxos: async () => ({ vtxos: [{ txid: "55".repeat(32), vout: 0, value: 500, createdAt: new Date(), script: hex.encode(decoded.pkScript) }] }) };
    expect(await settleDestinationPayments(store, indexer as never)).toBe(1);
    store.create({ paymentHash: "alias-replay", pr: "", sessionId: "test", paymentOption: "arkade", paymentDestination: alias, amountMsat: 500_000 });
    expect(await settleDestinationPayments(store, indexer as never)).toBe(0);
    expect(store.get("alias-replay")?.settled).toBe(false);
  });
});
