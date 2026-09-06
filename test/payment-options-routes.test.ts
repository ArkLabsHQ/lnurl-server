import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { createServer } from "../src/server.js";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { MemorySettlementStore } from "../src/settlement-store.js";
import type { LnurlServiceConfig } from "../src/types.js";

const CONFIG: LnurlServiceConfig = { port: 0, baseUrl: "", minSendable: 1000, maxSendable: 100_000_000, invoiceTimeoutMs: 3000 };
const ARK = "ark1qexampledestination";
const CLAIMPK = "02" + "ab".repeat(32); // 33-byte compressed pubkey (66 hex chars)

function start(repos: Repositories, settlements?: MemorySettlementStore) {
  const server = http.createServer();
  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.on("request", createServer({ ...CONFIG, baseUrl: `http://127.0.0.1:${port}` }, { repos, ...(settlements ? { settlements } : {}) }));
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) });
    });
  });
}
function getJson(url: string, host: string) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    http.get(url, { headers: { Host: host } }, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(JSON.parse(d))); }).on("error", reject);
  });
}

let db: Db; let repos: Repositories; let ctx: Awaited<ReturnType<typeof start>>; let domainId: number;
beforeEach(async () => {
  db = openDb(":memory:"); runMigrations(db); repos = createRepositories(db);
  domainId = repos.domains.create({ domain: "domain.com", allocationModes: ["self"] }).id;
  ctx = await start(repos);
});
afterEach(async () => { await ctx.close(); db.close(); });

function addr(username: string, withArkade: boolean) {
  const a = repos.addresses.create({ domainId, username, status: "active", sessionId: `sess-${username}` });
  if (withArkade) repos.addresses.setOfflineReceive(a.id, ARK, CLAIMPK);
  return a;
}

describe("LUD-XX paymentOptions", () => {
  it("advertises lightning + arkade when an Arkade identity is registered", async () => {
    addr("alice", true);
    const meta = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice`, "domain.com");
    expect(meta.paymentOptions).toEqual([
      { id: "lightning", type: "lightning" },
      { id: "arkade", type: "arkade" },
    ]);
  });

  it("omits paymentOptions without an Arkade identity (pure LUD-06)", async () => {
    addr("bob", false);
    const meta = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/bob`, "domain.com");
    expect(meta.paymentOptions).toBeUndefined();
    expect(meta.tag).toBe("payRequest");
  });

  it("serves the arkade destination + a non-pr verify record", async () => {
    addr("alice", true);
    const cb = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=50000&paymentOption=arkade`, "domain.com");
    expect(cb).toMatchObject({ status: "OK", paymentOption: "arkade", paymentDestination: ARK });
    expect(typeof cb.verify).toBe("string");

    const verifyId = String(cb.verify).split("/").pop()!;
    const v = await getJson(`${ctx.baseUrl}/lnurl/verify/${verifyId}`, "domain.com");
    expect(v).toMatchObject({
      status: "OK",
      settled: false,
      paymentOption: "arkade",
      paymentDestination: ARK,
      paymentReference: null,
    });
    expect(v.pr).toBeUndefined();
  });

  it("errors on an unknown paymentOption", async () => {
    addr("alice", true);
    const cb = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=50000&paymentOption=onchain`, "domain.com");
    expect(cb.status).toBe("ERROR");
    expect(String(cb.reason)).toMatch(/unsupported/i);
  });

  it("errors when arkade is selected but no identity is registered", async () => {
    addr("bob", false);
    const cb = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/bob/callback?amount=50000&paymentOption=arkade`, "domain.com");
    expect(cb.status).toBe("ERROR");
  });

  it("persists the agreed amount on the destination record", async () => {
    const settlements = new MemorySettlementStore(60_000);
    await ctx.close();
    ctx = await start(repos, settlements);
    addr("alice", true);
    const cb = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=50000&paymentOption=arkade`, "domain.com");
    const verifyId = String(cb.verify).split("/").pop()!;
    expect(settlements.get(verifyId)).toMatchObject({ amountMsat: 50000, paymentOption: "arkade", paymentDestination: ARK });
  });

  it("serves the arkade destination for a sessionless address (no SSE needed)", async () => {
    const a = repos.addresses.create({ domainId, username: "carol", status: "active" }); // no sessionId
    repos.addresses.setOfflineReceive(a.id, ARK, CLAIMPK);
    const cb = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/carol/callback?amount=50000&paymentOption=arkade`, "domain.com");
    expect(cb).toMatchObject({ status: "OK", paymentOption: "arkade", paymentDestination: ARK });
    // ...but the default lightning rail still can't run without a session
    const ln = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/carol/callback?amount=50000`, "domain.com");
    expect(ln.status).toBe("ERROR");
    expect(String(ln.reason)).toMatch(/offline/i);
  });

  it("matches paymentOption case-insensitively", async () => {
    addr("alice", true);
    const cb = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=50000&paymentOption=Arkade`, "domain.com");
    expect(cb).toMatchObject({ status: "OK", paymentOption: "arkade" });
  });

  it("rejects sub-satoshi amounts on the destination rail (LUD-XX: no rounding)", async () => {
    addr("alice", true);
    const cb = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=50500&paymentOption=arkade`, "domain.com");
    expect(cb.status).toBe("ERROR");
    expect(String(cb.reason)).toMatch(/whole number of satoshis/i);
  });

  it("rate-limits the destination branch per IP", async () => {
    addr("alice", true);
    let last: Record<string, unknown> = {};
    for (let i = 0; i < 30; i++) {
      last = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=50000&paymentOption=arkade`, "domain.com");
      expect(last.status).toBe("OK");
    }
    const res = await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      http.get(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=50000&paymentOption=arkade`, { headers: { Host: "domain.com" } }, (r) => {
        let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => resolve({ status: r.statusCode ?? 0, body: JSON.parse(d) }));
      }).on("error", reject);
    });
    expect(res.status).toBe(429);
  });
});
