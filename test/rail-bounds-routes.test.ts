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

function start(
  repos: Repositories,
  railLimits?: ServerDeps["railLimits"],
  offlineSwapCreator?: OfflineSwapCreator,
  solverDiscovery?: ServerDeps["solverDiscovery"],
  arkDustSat?: number,
) {
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
            ...(solverDiscovery ? { solverDiscovery } : {}),
            ...(arkDustSat ? { arkDustSat } : {}),
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

  // The lightning branch reaches its bounds check before the session-online
  // check, so a narrowed interactive rail refuses without a live session.
  it("refuses an out-of-range amount on the lightning callback branch", async () => {
    ctx = await start(repos, { "interactive-lightning": { maxSendable: 5_000_000 } });
    addr("alice");
    const cb = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=50000000`, "domain.com");
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

const discovery = (status: { ready: boolean; reason?: string; receiveBounds?: { minSat: number; maxSat: number } }): ServerDeps["solverDiscovery"] =>
  ({ status: () => status });

describe("arkd dust floor on the VTXO-settled rails", () => {
  const optionsOf = async (username: string) =>
    ((await getJson(`${ctx.baseUrl}/.well-known/lnurlp/${username}`, "domain.com")).paymentOptions ??
      []) as Array<Record<string, unknown>>;

  // The reported symptom: the arkade option advertised a 0.4-sat minimum while
  // arkd refuses any output under 330 sats, so a payer following the payRequest
  // sends an amount that can never land.
  it("raises the arkade option to arkd's dust, over the configured minimum", async () => {
    ctx = await start(repos, undefined, undefined, undefined, 330);
    addr("alice");
    expect((await optionsOf("alice")).find((o) => o.id === "arkade")?.minSendable).toBe(330_000);
  });

  // 400 msat is a legal lightning minimum and an unpayable arkade one; with dust
  // unknown the whole-sat floor is the only thing standing between the two.
  it("never advertises a fractional sat when dust is unknown", async () => {
    repos.domains.update(domainId, { domain: "domain.com", allocationModes: ["self"], minSendable: 400 });
    ctx = await start(repos);
    addr("alice");
    const options = await optionsOf("alice");
    expect(options.find((o) => o.id === "lightning")?.minSendable).toBeUndefined();
    expect(options.find((o) => o.id === "arkade")?.minSendable).toBe(1_000);
  });

  it("leaves the lightning option on the envelope, which carries millisats", async () => {
    ctx = await start(repos, undefined, undefined, undefined, 330);
    addr("alice");
    const lightning = (await optionsOf("alice")).find((o) => o.id === "lightning");
    expect(lightning).toEqual({ id: "lightning", type: "lightning" });
  });

  it("refuses an arkade amount below dust at the callback, not after the money moved", async () => {
    ctx = await start(repos, undefined, undefined, undefined, 330);
    addr("alice");
    const cb = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=100000&paymentOption=arkade`, "domain.com");
    expect(cb.status).toBe("ERROR");
  });
});

describe("solver-derived offline-swap bounds", () => {
  // The production bug: the card caps the payer's leg at 25000 sats while the
  // payRequest quoted the 100000-sat envelope, refusing a legal amount after the fact.
  it("narrows the top-level pair to what the discovered solver serves", async () => {
    ctx = await start(repos, undefined, swapCreator, discovery({ ready: true, receiveBounds: { minSat: 1000, maxSat: 25_000 } }));
    addr("alice");
    const meta = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice`, "domain.com");
    expect(meta.minSendable).toBe(1_000_000);
    expect(meta.maxSendable).toBe(25_000_000);
  });

  it("refuses an amount above the solver's range, quoting the narrowed pair", async () => {
    ctx = await start(repos, undefined, swapCreator, discovery({ ready: true, receiveBounds: { minSat: 1000, maxSat: 25_000 } }));
    addr("alice");
    const cb = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=50000000`, "domain.com");
    expect(cb.status).toBe("ERROR");
    expect(String(cb.reason)).toBe("Amount must be between 1000000 and 25000000 millisats");
  });

  it("still reaches the creator for an amount inside the solver's range", async () => {
    const created: number[] = [];
    const creator = {
      create: async ({ amountSat }: { amountSat: number }) => { created.push(amountSat); throw new Error("quoted"); },
      isSettled: async () => false,
    } as unknown as OfflineSwapCreator;
    ctx = await start(repos, undefined, creator, discovery({ ready: true, receiveBounds: { minSat: 1000, maxSat: 25_000 } }));
    addr("alice");
    await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=25000000`, "domain.com");
    expect(created).toEqual([25_000]);
  });

  it("does not let a solver range widen the server envelope", async () => {
    ctx = await start(repos, undefined, swapCreator, discovery({ ready: true, receiveBounds: { minSat: 1, maxSat: 500_000 } }));
    addr("alice");
    const meta = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice`, "domain.com");
    expect(meta.minSendable).toBe(1000);
    expect(meta.maxSendable).toBe(100_000_000);
  });

  it("takes the tighter of the operator's limit and the solver's range", async () => {
    ctx = await start(
      repos,
      { "offline-swap": { maxSendable: 10_000_000 } },
      swapCreator,
      discovery({ ready: true, receiveBounds: { minSat: 1000, maxSat: 25_000 } }),
    );
    addr("alice");
    const meta = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice`, "domain.com");
    expect(meta.maxSendable).toBe(10_000_000);
  });

  // Nothing usable discovered: the rail is unavailable, so the pair is the interactive rail's.
  it("leaves the envelope to the interactive rail when discovery is empty", async () => {
    ctx = await start(repos, undefined, swapCreator, discovery({ ready: false, reason: "no usable lightning-receive solver cards" }));
    addr("alice");
    const meta = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice`, "domain.com");
    expect(meta.minSendable).toBe(1000);
    expect(meta.maxSendable).toBe(100_000_000);
    const cb = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice/callback?amount=50000000`, "domain.com");
    expect(String(cb.reason)).toBe("offline receive unavailable: no usable lightning-receive solver cards");
  });

  it("follows a refresh that republishes a narrower range", async () => {
    let bounds = { minSat: 1000, maxSat: 50_000 };
    ctx = await start(repos, undefined, swapCreator, { status: () => ({ ready: true, receiveBounds: bounds }) });
    addr("alice");
    expect((await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice`, "domain.com")).maxSendable).toBe(50_000_000);
    bounds = { minSat: 1000, maxSat: 25_000 };
    expect((await getJson(`${ctx.baseUrl}/.well-known/lnurlp/alice`, "domain.com")).maxSendable).toBe(25_000_000);
  });
});
