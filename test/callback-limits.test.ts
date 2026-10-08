import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createServer } from "../src/http/server.js";
import { loadConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import type { LnurlServiceConfig } from "../src/types/index.js";

let db: Db; let repos: Repositories;
beforeEach(() => {
  db = openDb(":memory:"); runMigrations(db); repos = createRepositories(db);
  const domainId = repos.domains.create({ domain: "domain.com", allocationModes: ["self"] }).id;
  const alice = repos.addresses.create({ domainId, username: "alice", status: "active", sessionId: "sess-alice" });
  repos.addresses.setOfflineReceive(alice.id, "ark1qexampledestination", "02" + "ab".repeat(32));
});
afterEach(() => db.close());

const server = (config: Partial<LnurlServiceConfig>) =>
  createServer({ port: 0, baseUrl: "http://localhost", minSendable: 1000, maxSendable: 100_000_000, ...config }, { repos });

/** One destination callback, a branch the shared callback limiter guards; resolves to its status. */
async function callback(app: ReturnType<typeof server>, forwardedFor?: string): Promise<number> {
  const req = request(app).get("/.well-known/lnurlp/alice/callback?amount=50000&paymentOption=arkade").set("Host", "domain.com");
  return (await (forwardedFor ? req.set("X-Forwarded-For", forwardedFor) : req)).status;
}

const forwarders = (list: string) => loadConfig({ TRUSTED_FORWARDERS: list }).trustedForwarders;

describe("LUD-16 callback limiter", () => {
  it("takes its per-IP budget from callbackRateLimitPerMin", async () => {
    const app = server({ callbackRateLimitPerMin: 2 });
    expect([await callback(app), await callback(app), await callback(app)]).toEqual([200, 200, 429]);
  });

  // Default TRUST_PROXY=1: the test client plays the reverse proxy, which appends its peer's address.
  it("gives each payer a trusted forwarder relays a bucket of its own", async () => {
    const app = server({ callbackRateLimitPerMin: 1, trustedForwarders: forwarders("203.0.113.10") });
    expect(await callback(app, "198.51.100.1, 203.0.113.10")).toBe(200);
    expect(await callback(app, "198.51.100.1, 203.0.113.10")).toBe(429);
    expect(await callback(app, "198.51.100.2, 203.0.113.10")).toBe(200);
  });

  it("ignores the X-Forwarded-For of any other client, so naming payers cannot dodge the limit", async () => {
    const app = server({ callbackRateLimitPerMin: 1, trustedForwarders: forwarders("203.0.113.10") });
    expect(await callback(app, "198.51.100.1, 192.0.2.66")).toBe(200);
    expect(await callback(app, "198.51.100.2, 192.0.2.66")).toBe(429);
    expect(await callback(app, "198.51.100.3, 203.0.113.10, 192.0.2.66")).toBe(429);
  });

  it("matches forwarders by CIDR, IPv6 and IPv4-mapped address", async () => {
    const app = server({ callbackRateLimitPerMin: 1, trustedForwarders: forwarders(" 203.0.113.0/24 , 2001:db8::/32 ") });
    let payer = 0;
    const statuses: Record<string, number[]> = {};
    for (const via of ["203.0.113.77", "2001:db8::5", "::ffff:203.0.113.78", "203.0.114.1"]) {
      statuses[via] = [await callback(app, `198.51.100.${++payer}, ${via}`), await callback(app, `198.51.100.${++payer}, ${via}`)];
    }
    expect(statuses).toEqual({
      "203.0.113.77": [200, 200],
      "2001:db8::5": [200, 200],
      "::ffff:203.0.113.78": [200, 200],
      "203.0.114.1": [200, 429],
    });
  });

  it("trusts a forwarder that connects directly, with TRUST_PROXY=false", async () => {
    const listed = server({ trustProxy: false, callbackRateLimitPerMin: 1, trustedForwarders: forwarders("127.0.0.1") });
    expect([await callback(listed, "198.51.100.1"), await callback(listed, "198.51.100.2")]).toEqual([200, 200]);
    const unlisted = server({ trustProxy: false, callbackRateLimitPerMin: 1 });
    expect([await callback(unlisted, "198.51.100.1"), await callback(unlisted, "198.51.100.2")]).toEqual([200, 429]);
  });
});
