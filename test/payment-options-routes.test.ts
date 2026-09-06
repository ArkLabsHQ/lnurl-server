import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { createServer } from "../src/server.js";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { MemorySettlementStore } from "../src/settlement-store.js";
import type { OfflineSwapCreator } from "../src/intent-swap.js";
import type { LnurlServiceConfig } from "../src/types.js";
import type { CovenantDestinationProvider } from "../src/covenant-destination.js";

const CONFIG: LnurlServiceConfig = { port: 0, baseUrl: "", minSendable: 1000, maxSendable: 100_000_000, invoiceTimeoutMs: 3000 };
const ARK = "ark1qexampledestination";
const CLAIMPK = "02" + "ab".repeat(32); // 33-byte compressed pubkey (66 hex chars)

const fakeSwapCreator: OfflineSwapCreator = {
  create: async () => ({ swapId: "swap-1", invoice: "lnbc1offline", preimage: "ab".repeat(32), preimageHash: "cd".repeat(32), lockupAddress: ARK }),
  isSettled: async () => false,
};

function start(
  repos: Repositories,
  settlements?: MemorySettlementStore,
  offlineSwapCreator?: OfflineSwapCreator,
  covenantDestinations?: CovenantDestinationProvider,
) {
  const server = http.createServer();
  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.on(
        "request",
        createServer(
          { ...CONFIG, baseUrl: `http://127.0.0.1:${port}` },
          { repos, ...(settlements ? { settlements } : {}), ...(offlineSwapCreator ? { offlineSwapCreator } : {}), ...(covenantDestinations ? { covenantDestinations } : {}) },
        ),
      );
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

  it("hands out a per-payment covenant address, and records it for attribution", async () => {
    const settlements = new MemorySettlementStore(60_000);
    let n = 0;
    const provider: CovenantDestinationProvider = {
      derive: async () => {
        n += 1;
        return { address: `tark1derived${n}`, script: `5120${n}`, preimage: `${n}`.repeat(64), tapTree: `ee${n}` };
      },
    };
    await ctx.close();
    ctx = await start(repos, settlements, undefined, provider);
    addr("alice", true);

    const first = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=50000&paymentOption=arkade`, "domain.com");
    const second = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=50000&paymentOption=arkade`, "domain.com");

    // Two payers, same amount, same user — the case the static address cannot tell apart.
    expect(first.paymentDestination).toBe("tark1derived1");
    expect(second.paymentDestination).toBe("tark1derived2");
    expect(first.paymentDestination).not.toBe(second.paymentDestination);
    const rec = settlements.get(String(first.verify).split("/").pop()!);
    expect(rec).toMatchObject({ paymentDestination: "tark1derived1", covenantScript: "51201", covenantTapTree: "ee1" });
  });

  it("falls back to the static address when derivation fails, rather than refusing to be paid", async () => {
    const settlements = new MemorySettlementStore(60_000);
    const provider: CovenantDestinationProvider = {
      derive: async () => {
        throw new Error("arkd unreachable");
      },
    };
    await ctx.close();
    ctx = await start(repos, settlements, undefined, provider);
    addr("alice", true);

    const cb = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=50000&paymentOption=arkade`, "domain.com");

    expect(cb).toMatchObject({ status: "OK", paymentDestination: ARK });
    expect(settlements.get(String(cb.verify).split("/").pop()!)?.covenantScript).toBeNull();
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

  it("echoes paymentOption on the pr response only when explicitly selected", async () => {
    await ctx.close();
    ctx = await start(repos, new MemorySettlementStore(60_000), fakeSwapCreator);
    addr("alice", true); // wallet session exists but is offline → corridor swap serves
    const explicit = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=50000&paymentOption=lightning`, "domain.com");
    expect(explicit).toMatchObject({ pr: "lnbc1offline", paymentOption: "lightning" });
    const implicit = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=50000`, "domain.com");
    expect(implicit.pr).toBe("lnbc1offline");
    expect(implicit.paymentOption).toBeUndefined();
  });
});
