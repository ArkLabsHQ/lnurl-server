import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { createServer, type ServerDeps } from "../src/server.js";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { MemorySettlementStore } from "../src/settlement-store.js";
import type { OfflineSwapCreator } from "../src/intent-swap.js";
import type { LnurlServiceConfig } from "../src/types.js";

/** Present only so the offline-swap rail counts as available; never called. */
const swapCreator = {
  create: async () => {
    throw new Error("not used");
  },
  isSettled: async () => false,
} as unknown as OfflineSwapCreator;

const CONFIG: LnurlServiceConfig = { port: 0, baseUrl: "", minSendable: 1000, maxSendable: 100_000_000, invoiceTimeoutMs: 3000 };
const ARK = "ark1qexampledestination";
const CLAIMPK = "02" + "ab".repeat(32);

function start(repos: Repositories, railLimits?: ServerDeps["railLimits"], offlineSwapCreator?: OfflineSwapCreator) {
  const server = http.createServer();
  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.on(
        "request",
        createServer(
          { ...CONFIG, baseUrl: `http://127.0.0.1:${port}` },
          {
            repos,
            settlements: new MemorySettlementStore(86_400_000),
            ...(railLimits ? { railLimits } : {}),
            ...(offlineSwapCreator ? { offlineSwapCreator } : {}),
          },
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

let db: Db; let repos: Repositories; let domainId: number; let ctx: Awaited<ReturnType<typeof start>>;
beforeEach(() => {
  db = openDb(":memory:"); runMigrations(db); repos = createRepositories(db);
  domainId = repos.domains.create({ domain: "domain.com", allocationModes: ["self"] }).id;
});
afterEach(async () => { await ctx.close(); db.close(); });

function addr(username: string) {
  const a = repos.addresses.create({ domainId, username, status: "active", sessionId: `sess-${username}` });
  repos.addresses.setOfflineReceive(a.id, ARK, CLAIMPK);
  return a;
}

describe("per-rail sendable bounds", () => {
  it("leaves the payRequest untouched when no rail limits are configured", async () => {
    ctx = await start(repos);
    addr("alice");
    const meta = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice`, "domain.com");
    expect(meta.minSendable).toBe(1000);
    expect(meta.maxSendable).toBe(100_000_000);
    expect(meta.paymentOptions).toEqual([
      { id: "lightning", type: "lightning" },
      { id: "arkade", type: "arkade" },
    ]);
  });

  it("advertises a narrowed rail on its own option", async () => {
    ctx = await start(repos, { arkade: { minSendable: 10_000, maxSendable: 5_000_000 } });
    addr("alice");
    const meta = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice`, "domain.com");
    expect(meta.paymentOptions).toEqual([
      { id: "lightning", type: "lightning" },
      { id: "arkade", type: "arkade", minSendable: 10_000, maxSendable: 5_000_000 },
    ]);
  });

  // The bug this fixes: the payer is quoted the envelope, picks a legal amount
  // inside it, and the rail that actually serves refuses after they committed.
  it("refuses an amount the envelope allows but the chosen rail cannot carry", async () => {
    ctx = await start(repos, { arkade: { maxSendable: 5_000_000 } });
    addr("alice");
    const cb = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=50000000&paymentOption=arkade`, "domain.com");
    expect(cb.status).toBe("ERROR");
    expect(String(cb.reason)).toContain("5000000");
  });

  it("still serves an amount inside the narrowed rail", async () => {
    ctx = await start(repos, { arkade: { maxSendable: 5_000_000 } });
    addr("alice");
    const cb = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=4000000&paymentOption=arkade`, "domain.com");
    expect(cb).toMatchObject({ status: "OK", paymentOption: "arkade", paymentDestination: ARK });
  });

  // Absent paymentOption resolves to lightning, so the top-level pair has to be
  // what the lightning rail can honour rather than the widest any rail could.
  it("narrows the top-level pair to the lightning rail, not the arkade one", async () => {
    ctx = await start(repos, {
      "interactive-lightning": { maxSendable: 9_000_000 },
      arkade: { maxSendable: 1_000 },
    });
    addr("alice");
    const meta = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice`, "domain.com");
    expect(meta.maxSendable).toBe(9_000_000);
  });

  // A misconfiguration must not produce minSendable > maxSendable: that is not
  // a narrow payRequest, it is one no payer can satisfy at all.
  it("keeps the payRequest well-formed when two lightning rails do not overlap", async () => {
    // Both rails must be available for their ranges to intersect at all, so the
    // offline-swap creator has to be wired for this case to exist.
    ctx = await start(
      repos,
      { "interactive-lightning": { minSendable: 50_000_000 }, "offline-swap": { maxSendable: 10_000 } },
      swapCreator,
    );
    addr("alice");
    const meta = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice`, "domain.com");
    expect(Number(meta.minSendable)).toBeLessThanOrEqual(Number(meta.maxSendable));
    expect(meta.paymentOptions).toEqual([
      { id: "lightning", type: "lightning" },
      { id: "arkade", type: "arkade" },
    ]);
  });

  it("intersects both lightning rails when they do overlap", async () => {
    ctx = await start(
      repos,
      { "interactive-lightning": { maxSendable: 90_000_000 }, "offline-swap": { maxSendable: 1_000_000 } },
      swapCreator,
    );
    addr("alice");
    const meta = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice`, "domain.com");
    expect(meta.maxSendable).toBe(1_000_000);
  });

  // The top-level pair is the lightning rail's, and a client selecting an
  // option falls back to it when that option publishes nothing. So an option
  // that is WIDER than lightning must say so, or the client refuses amounts the
  // server would accept — the original bug, inverted.
  it("publishes an option's bounds when they are wider than the top-level pair", async () => {
    ctx = await start(repos, { "interactive-lightning": { minSendable: 50_000_000 } });
    addr("alice");
    const meta = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice`, "domain.com");
    expect(meta.minSendable).toBe(50_000_000);
    expect(meta.paymentOptions).toEqual([
      { id: "lightning", type: "lightning" },
      { id: "arkade", type: "arkade", minSendable: 1000 },
    ]);
  });

  it("does not let a rail widen past the server envelope", async () => {
    ctx = await start(repos, { "interactive-lightning": { maxSendable: 999_999_999 } });
    addr("alice");
    const meta = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice`, "domain.com");
    expect(meta.maxSendable).toBe(100_000_000);
  });
});
