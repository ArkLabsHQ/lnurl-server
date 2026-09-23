import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ArkAddress } from "@arkade-os/sdk";
import { createServer } from "../src/server.js";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { AddressService, ProvisioningError } from "../src/address-service.js";
import { OwnerSetupService } from "../src/owner-setup-service.js";
import { encodeOwnerSetup, ownerSetupDigest, type OwnerSetup } from "../src/enclave/owner-setup.js";
import type { LnurlServiceConfig } from "../src/types.js";

const picks = vi.hoisted(() => [] as string[]);
vi.mock("../src/usernames.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/usernames.js")>();
  return { ...actual, randomUsername: () => picks.shift() ?? actual.randomUsername() };
});

const CONFIG: LnurlServiceConfig = { port: 0, baseUrl: "", minSendable: 1000, maxSendable: 100_000_000, invoiceTimeoutMs: 3000 };
const HOST = "wallet.example";
const ownerKey = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const destination = (n: number) => new ArkAddress(new Uint8Array(32).fill(2), new Uint8Array(32).fill(n), "tark").encode();
const SETUP: OwnerSetup = {
  intent: "set", deployment: "lnurl-test", tenant: HOST, network: "regtest", domain: HOST, username: "alice",
  ownerPublicKey: bytesToHex(schnorr.getPublicKey(ownerKey)), arkadeDestination: destination(3),
  claimPublicKey: "02" + "ab".repeat(32), rails: ["offline-swap", "arkade"], revision: 1,
};
const signed = (s: OwnerSetup) => ({ payload: encodeOwnerSetup(s), signature: schnorr.sign(ownerSetupDigest(s), ownerKey) });
const token = () => randomBytes(32).toString("hex");

let db: Db; let repos: Repositories; let addresses: AddressService; let owners: OwnerSetupService;
let server: http.Server; let baseUrl: string;

beforeEach(async () => {
  db = openDb(":memory:"); runMigrations(db); repos = createRepositories(db);
  repos.domains.create({ domain: HOST, allocationModes: ["self", "random"] });
  addresses = new AddressService(repos, randomBytes(32));
  owners = new OwnerSetupService(repos, addresses, { deployment: "lnurl-test", network: "regtest", enrollment: true });
  server = http.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  server.on("request", createServer({ ...CONFIG, baseUrl }, { repos, addressService: addresses }));
});
afterEach(async () => {
  await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  db.close();
});

function send(method: string, path: string, body?: unknown, bearer?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${path}`, {
      method, headers: { Host: HOST, "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(data) }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function enroll(): { token: string; addressId: number } {
  const t = token();
  return { token: t, addressId: owners.submit({ ...signed(SETUP), token: t }).identity.addressId! };
}

const domainRow = () => repos.domains.getByDomain(HOST)!;
const refusedAsProtected = (fn: () => unknown) => {
  expect(fn).toThrow(ProvisioningError);
  try { fn(); } catch (e) { expect((e as ProvisioningError).code).toBe("protected_address"); }
};

describe("bearer writes on a protected address", () => {
  it("refuses the bearer arkade route on a protected address", async () => {
    const { token: t, addressId } = enroll();
    const out = await send("POST", "/lnurl/address/alice/arkade", { arkadeAddress: destination(9), claimPublicKey: "02" + "ee".repeat(32) }, t);

    expect(out).toMatchObject({ status: 409, body: { code: "protected_address" } });
    expect(repos.addresses.getById(addressId)).toMatchObject({ arkadeAddress: SETUP.arkadeDestination, claimPublicKey: SETUP.claimPublicKey });
    expect(owners.current(HOST, "alice")!.setup.arkadeDestination).toBe(SETUP.arkadeDestination);
    refusedAsProtected(() => addresses.setOfflineReceive(domainRow(), "alice", t, { arkadeAddress: destination(9), claimPublicKey: "02" + "ee".repeat(32) }));
  });

  it("refuses the bearer delete on a protected address", async () => {
    const { token: t, addressId } = enroll();
    expect(await send("DELETE", "/lnurl/address/alice", undefined, t)).toMatchObject({ status: 409, body: { code: "protected_address" } });
    expect(repos.addresses.getById(addressId)?.status).toBe("active");
    expect(owners.current(HOST, "alice")!.identity).toMatchObject({ state: "active", currentRevision: 1 });
  });

  it("still answers a stranger's token as not owning the address", async () => {
    enroll();
    expect((await send("DELETE", "/lnurl/address/alice", undefined, token())).status).toBe(404);
  });

  it("refuses re-registering a tombstoned username, which only its owner's signed setup re-links", async () => {
    const { addressId } = enroll();
    repos.addresses.delete(addressId);
    expect(repos.ownerSetups.identity(HOST, "alice")?.addressId).toBeNull();

    expect(await send("POST", "/lnurl/address", { username: "alice", token: token() })).toMatchObject({ status: 409, body: { code: "protected_address" } });
    refusedAsProtected(() => addresses.reserve(domainRow(), "alice"));
    refusedAsProtected(() => addresses.mint(domainRow(), "ALICE"));
    picks.push("alice", "bob");
    expect(addresses.register({ domain: domainRow(), token: token() }).address.username).toBe("bob");

    const relink = { ...SETUP, revision: 2, previousHash: bytesToHex(ownerSetupDigest(SETUP)) };
    const out = owners.submit({ ...signed(relink), token: token() });
    expect(repos.addresses.getById(out.identity.addressId!)).toMatchObject({ username: "alice", arkadeAddress: SETUP.arkadeDestination });
  });

  it("leaves a legacy address's bearer writes alone", async () => {
    const t = token();
    expect((await send("POST", "/lnurl/address", { username: "carol", token: t })).status).toBe(201);
    expect((await send("POST", "/lnurl/address/carol/arkade", { arkadeAddress: destination(4), claimPublicKey: "02" + "cd".repeat(32) }, t)).status).toBe(200);
    expect((await send("DELETE", "/lnurl/address/carol", undefined, t)).status).toBe(200);
  });
});
