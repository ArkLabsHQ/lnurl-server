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
});
