import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { MultisigTapscript, VtxoScript } from "@arkade-os/sdk";
import { createServer } from "../src/server.js";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { AddressService } from "../src/address-service.js";
import { CovenantSupplyStore, COVENANT_SUPPLY_SCHEME } from "../src/covenant-supply.js";
import { MemorySettlementStore } from "../src/settlement-store.js";
import { createCovenantDestinationProvider, deriveCovenantDestination } from "../src/covenant-destination.js";
import type { CovenantDestinationProvider } from "../src/covenant-destination.js";
import type { LnurlServiceConfig } from "../src/types.js";

const kat = JSON.parse(readFileSync(new URL("./fixtures/covenant-entropy-kat.json", import.meta.url), "utf8")) as {
  covenant: { entries: { index: number; preimage: string }[] };
};
const PREIMAGES = kat.covenant.entries.map((e) => e.preimage);

const KEY = randomBytes(32);
const TOKEN = "ab".repeat(32);
const CONFIG: LnurlServiceConfig = { port: 0, baseUrl: "", minSendable: 1000, maxSendable: 100_000_000, invoiceTimeoutMs: 3000 };

const xonly = (fill: number) => secp256k1.getPublicKey(new Uint8Array(32).fill(fill), true).subarray(1);
const serverPubkey = xonly(3);
const userPrivate = new Uint8Array(32).fill(4);
const userCompressed = secp256k1.getPublicKey(userPrivate, true);
const emulatorPubkey = secp256k1.getPublicKey(new Uint8Array(32).fill(5), true);
const ARK = new VtxoScript([MultisigTapscript.encode({ pubkeys: [xonly(9), serverPubkey] }).script])
  .address("tark", serverPubkey)
  .encode();

const PROFILE = { recoveryDelaySeconds: 86_528, emulatorPubkey: hex.encode(emulatorPubkey) };
const stubProvider: CovenantDestinationProvider = {
  profile: async () => PROFILE,
  derive: async () => ({ address: "tark1derived", script: "51201" }),
};

let db: Db;
let repos: Repositories;
let supply: CovenantSupplyStore;
let ctx: { baseUrl: string; close: () => Promise<void> };

function start(provider: CovenantDestinationProvider | undefined, opts: { insecureKeyStorage?: boolean } = {}) {
  const server = http.createServer();
  supply = new CovenantSupplyStore(db, KEY, opts);
  const svc = new AddressService(repos, KEY, supply);
  return new Promise<typeof ctx>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.on("request", createServer(
        { ...CONFIG, baseUrl: `http://127.0.0.1:${port}` },
        { repos, addressService: svc, ...(provider ? { covenantDestinations: provider } : {}) },
      ));
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) });
    });
  });
}

function req(method: string, url: string, opts: { host?: string; body?: unknown; bearer?: string } = {}) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json", Host: opts.host ?? "domain.com" };
    if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
    const r = http.request(url, { method, headers }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: d ? JSON.parse(d) : {} }));
    });
    r.on("error", reject);
    if (opts.body) r.write(JSON.stringify(opts.body));
    r.end();
  });
}

const identityBody = (covenantSupply?: unknown) => ({
  arkadeAddress: ARK,
  claimPublicKey: hex.encode(userCompressed),
  ...(covenantSupply !== undefined ? { covenantSupply } : {}),
});
const supplyBody = (startIndex: number, preimages: string[], profile: unknown = PROFILE) =>
  ({ scheme: COVENANT_SUPPLY_SCHEME, startIndex, preimages, profile });

const post = (body: unknown) => req("POST", `${ctx.baseUrl}/lnurl/address/alice/arkade`, { body, bearer: TOKEN });

beforeEach(async () => {
  db = openDb(":memory:");
  runMigrations(db);
  repos = createRepositories(db);
  repos.domains.create({ domain: "domain.com", allocationModes: ["self"] });
  ctx = await start(stubProvider);
  await req("POST", `${ctx.baseUrl}/lnurl/address`, { body: { username: "alice", token: TOKEN } });
});
afterEach(async () => { await ctx.close(); db.close(); });

describe("POST /lnurl/address/:username/arkade covenantSupply", () => {
  it("stores a supply and echoes what the client must check", async () => {
    const res = await post(identityBody(supplyBody(0, PREIMAGES)));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      covenantSupply: { accepted: true, nextIndex: 3, remaining: 3, scheme: COVENANT_SUPPLY_SCHEME, profile: PROFILE },
    });
    const address = repos.addresses.getByDomainAndUsername(1, "alice")!;
    expect(address.covenantScheme).toBe(COVENANT_SUPPLY_SCHEME);
    expect(JSON.parse(address.covenantProfile!)).toEqual(PROFILE);
  });

  // The dangerous compatibility direction, from the other side: a body with no
  // supply must still register the identity and must NOT echo one.
  it("still answers the old body shape, with no echo to mistake for acceptance", async () => {
    const res = await post(identityBody());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect("covenantSupply" in res.body).toBe(false);
    expect(repos.addresses.getByDomainAndUsername(1, "alice")!.arkadeAddress).toBe(ARK);
  });

  it("refuses a profile this server does not use", async () => {
    const res = await post(identityBody(supplyBody(0, PREIMAGES, { ...PROFILE, recoveryDelaySeconds: 4096 })));
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/profile does not match/);
    expect(db.prepare("SELECT COUNT(*) AS c FROM covenant_commitments").get()).toEqual({ c: 0 });
  });

  it("refuses a supply whose emulator key is not the one the covenant commits to", async () => {
    const res = await post(identityBody(supplyBody(0, PREIMAGES, { ...PROFILE, emulatorPubkey: "cd".repeat(33) })));
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/profile does not match/);
  });

  it("refuses a batch that does not start at nextIndex", async () => {
    await post(identityBody(supplyBody(0, PREIMAGES)));
    const res = await post(identityBody(supplyBody(7, [PREIMAGES[0]!])));
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/startIndex must be 3/);
  });

  it("refuses an oversize batch, bad hex and an unknown scheme", async () => {
    const big = Array.from({ length: 257 }, (_, i) => Buffer.alloc(32, i % 251).toString("hex"));
    expect((await post(identityBody(supplyBody(0, big)))).status).toBe(400);
    expect((await post(identityBody(supplyBody(0, ["ff"])))).status).toBe(400);
    expect((await post(identityBody({ ...supplyBody(0, PREIMAGES), scheme: "hd-v9" }))).status).toBe(400);
    expect((await post(identityBody({ ...supplyBody(0, PREIMAGES), profile: undefined }))).status).toBe(400);
    expect(db.prepare("SELECT COUNT(*) AS c FROM covenant_commitments").get()).toEqual({ c: 0 });
  });

  it("treats an identical re-post as a no-op rather than a conflict", async () => {
    const first = await post(identityBody(supplyBody(0, PREIMAGES)));
    const second = await post(identityBody(supplyBody(0, PREIMAGES)));
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(db.prepare("SELECT COUNT(*) AS c FROM covenant_commitments").get()).toEqual({ c: 3 });
  });

  it("appends the next batch at the index it reported", async () => {
    await post(identityBody(supplyBody(0, PREIMAGES)));
    const res = await post(identityBody(supplyBody(3, [Buffer.alloc(32, 9).toString("hex")])));
    expect(res.body).toMatchObject({ covenantSupply: { nextIndex: 4, remaining: 4 } });
  });

  // Covenant destinations are off by default, so failing the request here would
  // leave a supply-sending wallet unable to bind an Arkade identity at all —
  // losing offline receive over an optional extra. The absent echo is the
  // "not accepted" signal the client already checks.
  it("registers the identity but accepts no supply when no covenant rail is configured", async () => {
    await ctx.close();
    ctx = await start(undefined);
    await req("POST", `${ctx.baseUrl}/lnurl/address`, { body: { username: "bob", token: TOKEN } });
    const res = await req("POST", `${ctx.baseUrl}/lnurl/address/bob/arkade`, { body: identityBody(supplyBody(0, PREIMAGES)), bearer: TOKEN });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(res.body.covenantSupply).toBeUndefined();

    // And the identity really did bind: the arkade rail is what a supply-less
    // registration is for, so this is the thing the 400 used to destroy.
    const payRequest = await req("GET", `${ctx.baseUrl}/.well-known/lnurlp/bob`);
    expect((payRequest.body.paymentOptions as { id: string }[]).map((o) => o.id)).toContain("arkade");
  });

  it("refuses a supply when the encryption key is source-readable", async () => {
    await ctx.close();
    ctx = await start(stubProvider, { insecureKeyStorage: true });
    await req("POST", `${ctx.baseUrl}/lnurl/address`, { body: { username: "carol", token: TOKEN } });
    const res = await req("POST", `${ctx.baseUrl}/lnurl/address/carol/arkade`, { body: identityBody(supplyBody(0, PREIMAGES)), bearer: TOKEN });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/ALLOW_INSECURE_TOKEN_STORAGE/);
  });

  it("stores the swap leg on its own supply, echoed separately", async () => {
    const swapPreimages = [Buffer.alloc(32, 7).toString("hex")];
    const res = await post({ ...identityBody(supplyBody(0, PREIMAGES)), swapSupply: { scheme: COVENANT_SUPPLY_SCHEME, startIndex: 0, preimages: swapPreimages } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      covenantSupply: { nextIndex: 3, remaining: 3 },
      swapSupply: { accepted: true, nextIndex: 1, remaining: 1, scheme: COVENANT_SUPPLY_SCHEME },
    });
    // Separate tables, so index 0 in each is a different secret.
    const addressId = repos.addresses.getByDomainAndUsername(1, "alice")!.id;
    expect(Buffer.from(supply.at(addressId, 0, "covenant")!.preimage).toString("hex")).toBe(PREIMAGES[0]);
    expect(Buffer.from(supply.at(addressId, 0, "swap")!.preimage).toString("hex")).toBe(swapPreimages[0]);
  });

  it("takes a swap supply on its own, with no covenant profile to assert", async () => {
    const res = await post({ ...identityBody(), swapSupply: { scheme: COVENANT_SUPPLY_SCHEME, startIndex: 0, preimages: [Buffer.alloc(32, 7).toString("hex")] } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, swapSupply: { accepted: true, nextIndex: 1, remaining: 1, scheme: COVENANT_SUPPLY_SCHEME } });
    expect("covenantSupply" in res.body).toBe(false);
  });

  it("rejects a supply from a token that does not own the address", async () => {
    const res = await req("POST", `${ctx.baseUrl}/lnurl/address/alice/arkade`, { body: identityBody(supplyBody(0, PREIMAGES)), bearer: "cd".repeat(32) });
    expect(res.status).toBe(404);
    expect(db.prepare("SELECT COUNT(*) AS c FROM covenant_commitments").get()).toEqual({ c: 0 });
  });
});

describe("GET /lnurl/address/:username/covenant-recovery", () => {
  const settlements = () => new MemorySettlementStore(600_000);

  async function startWithStore(store: MemorySettlementStore, covenantParams?: (s: string[]) => Promise<Map<string, Record<string, string>>>) {
    await ctx.close();
    const server = http.createServer();
    supply = new CovenantSupplyStore(db, KEY);
    const svc = new AddressService(repos, KEY, supply);
    ctx = await new Promise<typeof ctx>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as { port: number };
        server.on("request", createServer(
          { ...CONFIG, baseUrl: `http://127.0.0.1:${port}` },
          { repos, addressService: svc, settlements: store, covenantDestinations: stubProvider, ...(covenantParams ? { covenantParams } : {}) },
        ));
        resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) });
      });
    });
  }

  it("serves every destination with the params needed to rebuild it", async () => {
    const store = settlements();
    await startWithStore(store, async (scripts) => new Map(scripts.map((s) => [s, { preimage: PREIMAGES[0]!, staticAddress: ARK }])));
    const addressId = repos.addresses.getByDomainAndUsername(1, "alice")!.id;
    store.create({ paymentHash: "v1", pr: "", sessionId: `addr:${addressId}`, addressId, paymentOption: "arkade", paymentDestination: "tark1a", covenantScript: "5120aa", covenantIndex: 0 });
    // The escape hatch: a pre-scheme destination has no index, and its params
    // are the only copy of a preimage no seed reproduces.
    store.create({ paymentHash: "v2", pr: "", sessionId: `addr:${addressId}`, addressId, paymentOption: "arkade", paymentDestination: "tark1b", covenantScript: "5120bb" });
    store.create({ paymentHash: "v3", pr: "lnbc1", sessionId: `addr:${addressId}`, addressId });

    const res = await req("GET", `${ctx.baseUrl}/lnurl/address/alice/covenant-recovery`, { bearer: TOKEN });

    expect(res.status).toBe(200);
    const destinations = res.body.destinations as Record<string, unknown>[];
    expect(destinations).toHaveLength(2);
    expect(destinations[0]).toMatchObject({ verifyId: "v1", covenantScript: "5120aa", covenantIndex: 0, params: { preimage: PREIMAGES[0] } });
    expect(destinations[1]).toMatchObject({ verifyId: "v2", covenantScript: "5120bb", covenantIndex: null });
  });

  it("reports the scheme and profile the supply was accepted under", async () => {
    const store = settlements();
    await startWithStore(store);
    await post(identityBody(supplyBody(0, PREIMAGES)));
    const res = await req("GET", `${ctx.baseUrl}/lnurl/address/alice/covenant-recovery`, { bearer: TOKEN });
    expect(res.body).toMatchObject({ scheme: COVENANT_SUPPLY_SCHEME, profile: PROFILE });
  });

  it("serves nothing to a token that does not own the address", async () => {
    await startWithStore(settlements());
    expect((await req("GET", `${ctx.baseUrl}/lnurl/address/alice/covenant-recovery`, { bearer: "cd".repeat(32) })).status).toBe(404);
    expect((await req("GET", `${ctx.baseUrl}/lnurl/address/alice/covenant-recovery`)).status).toBe(401);
  });
});

// The claim the whole change rests on: what the server builds from an uploaded
// supply is byte-for-byte what the owner rebuilds from the same preimage.
describe("an uploaded supply drives the address the owner can rebuild", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("derives index 0 from the batch, and records which index it spent", async () => {
    await post(identityBody(supplyBody(0, PREIMAGES)));
    vi.stubGlobal("fetch", async (url: string) =>
      new Response(
        JSON.stringify(
          String(url).includes("covclaimd-pubkey")
            ? { emulator_pub_key: hex.encode(emulatorPubkey) }
            : { signerPubkey: hex.encode(serverPubkey) },
        ),
        { status: 200 },
      ));
    const provider = createCovenantDestinationProvider({
      arkServerUrl: "https://ark.example",
      covclaimdUrl: "https://cc.example",
      recoveryDelaySeconds: PROFILE.recoveryDelaySeconds,
      supply,
    });
    const addressId = repos.addresses.getByDomainAndUsername(1, "alice")!.id;

    const derived = await provider.derive({ arkadeAddress: ARK, claimPublicKey: hex.encode(userCompressed), addressId });

    const rebuilt = deriveCovenantDestination({
      staticAddress: ARK,
      userPubkey: userCompressed,
      serverPubkey,
      emulatorPubkey,
      preimage: hex.decode(PREIMAGES[0]!),
      recoveryDelaySeconds: PROFILE.recoveryDelaySeconds,
    });
    expect(derived.address).toBe(rebuilt.address);
    expect(derived.script).toBe(rebuilt.script);
    expect(derived.covenantIndex).toBe(0);

    const next = await provider.derive({ arkadeAddress: ARK, claimPublicKey: hex.encode(userCompressed), addressId });
    expect(next.covenantIndex).toBe(1);
    expect(next.script).not.toBe(derived.script);
  });
});
