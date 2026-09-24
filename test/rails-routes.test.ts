import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { createServer } from "../src/server.js";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import type { OfflineSwapCreator } from "../src/intent-swap.js";
import type { CovenantDestinationProvider } from "../src/covenant-destination.js";
import type { LnurlServiceConfig } from "../src/types/index.js";

const CONFIG: LnurlServiceConfig = { port: 0, baseUrl: "", minSendable: 1000, maxSendable: 100_000_000, invoiceTimeoutMs: 3000 };
const ARK = "ark1qexampledestination";
const CLAIMPK = "02" + "ab".repeat(32);

const fakeSwapCreator: OfflineSwapCreator = {
  create: async () => ({ swapId: "swap-1", invoice: "lnbc1offline", preimage: "ab".repeat(32), preimageHash: "cd".repeat(32), lockupAddress: ARK, recovery: { version: 1, solverName: "fake", solverPubkey: "11".repeat(32), relays: [], rfqId: "swap-1", lockupAddress: ARK, expectedAmount: 50, script: {} } }),
  isSettled: async () => false,
};

function start(repos: Repositories, extra?: Record<string, unknown>) {
  const server = http.createServer();
  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.on("request", createServer({ ...CONFIG, baseUrl: `http://127.0.0.1:${port}` }, { repos, ...extra }));
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) });
    });
  });
}

function getJson(url: string, host: string) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    http.get(url, { headers: { Host: host } }, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(JSON.parse(d))); }).on("error", reject);
  });
}

const readyDiscovery = { status: () => ({ ready: true }) };
const downDiscovery = { status: () => ({ ready: false, reason: "no cards" }) };

let db: Db; let repos: Repositories; let ctx: Awaited<ReturnType<typeof start>>; let domainId: number;
beforeEach(async () => {
  db = openDb(":memory:"); runMigrations(db); repos = createRepositories(db);
  domainId = repos.domains.create({ domain: "domain.com", allocationModes: ["self"] }).id;
  if (ctx) await ctx.close();
});
afterEach(async () => { await ctx.close(); db.close(); });

async function withServer(extra?: Record<string, unknown>) {
  ctx = await start(repos, extra);
  return ctx;
}

function sessionlessIdentity(username: string) {
  const a = repos.addresses.create({ domainId, username, status: "active", sessionId: `sess-${username}` });
  repos.addresses.setOfflineReceive(a.id, ARK, CLAIMPK);
  return repos.addresses.getById(a.id)!;
}

describe("per-address rail policy", () => {
  it("omits a disabled arkade rail from the payRequest", async () => {
    const a = sessionlessIdentity("alice");
    repos.addresses.setDisabledRails(a.id, ["arkade"]);
    await withServer();
    const meta = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice`, "domain.com");
    expect(meta.paymentOptions).toBeUndefined();
  });

  it("rejects paymentOption=arkade when the rail is disabled for the address", async () => {
    const a = sessionlessIdentity("alice");
    repos.addresses.setDisabledRails(a.id, ["arkade"]);
    await withServer();
    const cb = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=50000&paymentOption=arkade`, "domain.com");
    expect(cb).toMatchObject({ status: "ERROR", reason: "paymentOption arkade is disabled for this address" });
  });

  it("fails loudly (not silently) when discovery is down while staying up", async () => {
    sessionlessIdentity("bob");
    await withServer({ offlineSwapCreator: fakeSwapCreator, solverDiscovery: downDiscovery });
    const cb = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/bob/callback?amount=50000`, "domain.com");
    expect(cb).toMatchObject({ status: "ERROR", reason: "offline receive unavailable: no cards" });
    const live = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/bob`, "domain.com");
    expect(live.tag).toBe("payRequest");
  });

  it("reports a disabled offline rail instead of quoting", async () => {
    const a = sessionlessIdentity("carol");
    repos.addresses.setDisabledRails(a.id, ["offline-swap"]);
    let quoted = 0;
    const counting: OfflineSwapCreator = { ...fakeSwapCreator, create: async (...args) => { quoted++; return fakeSwapCreator.create(...args); } };
    await withServer({ offlineSwapCreator: counting, solverDiscovery: readyDiscovery });
    const cb = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/carol/callback?amount=50000`, "domain.com");
    expect(cb).toMatchObject({ status: "ERROR", reason: "offline receive is disabled for this address" });
    expect(quoted).toBe(0);
  });

  it("serves the offline swap when the rail is enabled and discovery is ready", async () => {
    sessionlessIdentity("dave");
    await withServer({ offlineSwapCreator: fakeSwapCreator, solverDiscovery: readyDiscovery });
    const cb = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/dave/callback?amount=50000`, "domain.com");
    expect(cb.pr).toBe("lnbc1offline");
    expect(typeof cb.verify).toBe("string");
  });

  it("falls back to the static address when covenant destinations are disabled", async () => {
    const a = sessionlessIdentity("erin");
    repos.addresses.setDisabledRails(a.id, ["covenant"]);
    let derived = 0;
    const provider: CovenantDestinationProvider = {
      derive: async () => { derived++; return { address: "tark1derived", script: "5120", preimage: "00".repeat(32), tapTree: "ee", payoutScript: "51" }; },
    };
    await withServer({ covenantDestinations: provider });
    const cb = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/erin/callback?amount=50000&paymentOption=arkade`, "domain.com");
    expect(cb).toMatchObject({ status: "OK", paymentOption: "arkade", paymentDestination: ARK });
    expect(derived).toBe(0);
  });

  it("rejects the session relay when interactive lightning is disabled", async () => {
    const a = repos.addresses.create({ domainId, username: "frank", status: "active", sessionId: "sess-frank" });
    repos.addresses.setDisabledRails(a.id, ["interactive-lightning"]);
    await withServer();
    const cb = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/frank/callback?amount=50000`, "domain.com");
    expect(cb).toMatchObject({ status: "ERROR", reason: "lightning receive is disabled for this address" });
  });
});