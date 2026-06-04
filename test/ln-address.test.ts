import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { createServer } from "../src/server.js";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { encryptToken } from "../src/crypto.js";
import type { LnurlServiceConfig } from "../src/types.js";

const KEY = randomBytes(32);
const CONFIG: LnurlServiceConfig = { port: 0, baseUrl: "", minSendable: 1000, maxSendable: 100_000_000, invoiceTimeoutMs: 3000 };

function sessionIdFor(token: string): string {
  return createHash("sha256").update(Buffer.from(token, "hex")).digest("hex").slice(0, 32);
}

function start(repos: Repositories) {
  const server = http.createServer();
  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      const cfg = { ...CONFIG, baseUrl: `http://127.0.0.1:${port}` };
      server.on("request", createServer(cfg, { repos }));
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
      });
    });
  });
}

async function getJson(url: string, host?: string) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const headers: Record<string, string> = host ? { Host: host } : {};
    http.get(url, { headers }, (res) => {
      let data = ""; res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
    }).on("error", reject);
  });
}

let db: Db; let repos: Repositories; let ctx: Awaited<ReturnType<typeof start>>;
beforeEach(async () => {
  db = openDb(":memory:"); runMigrations(db); repos = createRepositories(db);
  const domainId = repos.domains.create({ domain: "domain.com", allocationModes: ["self"] }).id;
  const token = "ab".repeat(32);
  repos.addresses.create({ domainId, username: "devious", status: "active", sessionId: sessionIdFor(token), encryptedToken: encryptToken(token, KEY) });
  ctx = await start(repos);
});
afterEach(async () => { await ctx.close(); db.close(); });

describe("GET /.well-known/lnurlp/:username", () => {
  it("returns LUD-16 payRequest metadata with the identifier", async () => {
    const res = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/devious`, "domain.com");
    expect(res.body.tag).toBe("payRequest");
    expect(String(res.body.callback)).toContain("/.well-known/lnurlp/devious/callback");
    const meta = JSON.parse(res.body.metadata as string) as [string, string][];
    expect(meta).toContainEqual(["text/identifier", "devious@domain.com"]);
  });

  it("errors for an unknown username", async () => {
    const res = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/nobody`, "domain.com");
    expect(res.body.status).toBe("ERROR");
  });

  it("errors for an unconfigured domain", async () => {
    const res = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/devious`, "unknown.com");
    expect(res.body.status).toBe("ERROR");
  });

  it("errors when the domain is disabled", async () => {
    const domain = repos.domains.getByDomain("domain.com")!;
    repos.domains.update(domain.id, { enabled: false });
    const res = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/devious`, "domain.com");
    expect(res.body.status).toBe("ERROR");
  });

  it("reflects per-domain minSendable/maxSendable overrides", async () => {
    const domain = repos.domains.getByDomain("domain.com")!;
    repos.domains.update(domain.id, { minSendable: 5000, maxSendable: 50_000 });
    const res = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/devious`, "domain.com");
    expect(res.body.minSendable).toBe(5000);
    expect(res.body.maxSendable).toBe(50_000);
    // Must not match the global CONFIG values
    expect(res.body.minSendable).not.toBe(CONFIG.minSendable);
    expect(res.body.maxSendable).not.toBe(CONFIG.maxSendable);
  });

  it("routes by Host header — domain2.com resolves to a different address than domain.com", async () => {
    // Seed a second domain and address
    const domain2Id = repos.domains.create({ domain: "domain2.com", allocationModes: ["self"] }).id;
    const token2 = "ef".repeat(32);
    repos.addresses.create({ domainId: domain2Id, username: "other", status: "active", sessionId: sessionIdFor(token2), encryptedToken: encryptToken(token2, KEY) });

    // domain2.com request resolves the "other" address on domain2
    const res2 = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/other`, "domain2.com");
    expect(res2.body.tag).toBe("payRequest");
    const meta2 = JSON.parse(res2.body.metadata as string) as [string, string][];
    expect(meta2).toContainEqual(["text/identifier", "other@domain2.com"]);

    // domain.com request still resolves the original "devious" address
    const res1 = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/devious`, "domain.com");
    expect(res1.body.tag).toBe("payRequest");
    const meta1 = JSON.parse(res1.body.metadata as string) as [string, string][];
    expect(meta1).toContainEqual(["text/identifier", "devious@domain.com"]);

    // Cross-domain lookup fails: "other" is not on domain.com
    const resCross = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/other`, "domain.com");
    expect(resCross.body.status).toBe("ERROR");
  });
});
