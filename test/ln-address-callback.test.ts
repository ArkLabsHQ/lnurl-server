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
const sid = (t: string) => createHash("sha256").update(Buffer.from(t, "hex")).digest("hex").slice(0, 32);

function start(repos: Repositories) {
  const server = http.createServer();
  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.on("request", createServer({ ...CONFIG, baseUrl: `http://127.0.0.1:${port}` }, { repos }));
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) });
    });
  });
}
function getJson(url: string, host: string) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    http.get(url, { headers: { Host: host } }, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(JSON.parse(d))); }).on("error", reject);
  });
}
// Opens an SSE session for `token`, resolves once session_created arrives; returns the live response + token's sessionId.
function openSse(baseUrl: string, token: string) {
  return new Promise<{ res: http.IncomingMessage; abort: () => void }>((resolve, reject) => {
    const req = http.request(`${baseUrl}/lnurl/session`, { method: "POST", headers: { "Content-Type": "application/json" } });
    req.on("response", (res) => {
      let buf = "";
      const onData = (c: Buffer) => { buf += c.toString(); if (buf.includes("session_created")) { res.off("data", onData); resolve({ res, abort: () => { res.destroy(); req.destroy(); } }); } };
      res.on("data", onData); res.on("error", reject);
    });
    req.on("error", reject); req.write(JSON.stringify({ token })); req.end();
  });
}

let db: Db; let repos: Repositories; let ctx: Awaited<ReturnType<typeof start>>;
const TOKEN = "cd".repeat(32);
beforeEach(async () => {
  db = openDb(":memory:"); runMigrations(db); repos = createRepositories(db);
  const domainId = repos.domains.create({ domain: "domain.com", allocationModes: ["self"] }).id;
  repos.addresses.create({ domainId, username: "devious", status: "active", sessionId: sid(TOKEN), encryptedToken: encryptToken(TOKEN, KEY) });
  ctx = await start(repos);
});
afterEach(async () => { await ctx.close(); db.close(); });

describe("GET /.well-known/lnurlp/:username/callback", () => {
  it("returns an error when the wallet is offline", async () => {
    const body = await getJson(`${ctx.baseUrl}/.well-known/lnurlp/devious/callback?amount=50000`, "domain.com");
    expect(body.status).toBe("ERROR");
    expect(String(body.reason)).toMatch(/offline/i);
  });

  it("routes to the online wallet and returns its bolt11", async () => {
    const sse = await openSse(ctx.baseUrl, TOKEN); // session_id now matches the seeded address
    try {
      const payer = getJson(`${ctx.baseUrl}/.well-known/lnurlp/devious/callback?amount=50000`, "domain.com");
      // Wallet receives invoice_request and posts a bolt11 back
      await new Promise((r) => setTimeout(r, 50));
      await new Promise<void>((resolve, reject) => {
        const req = http.request(`${ctx.baseUrl}/lnurl/session/${sid(TOKEN)}/invoice`, {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        }, (res) => { res.on("data", () => {}); res.on("end", () => resolve()); });
        req.on("error", reject); req.write(JSON.stringify({ pr: "lnbc1viaaddress" })); req.end();
      });
      expect((await payer).pr).toBe("lnbc1viaaddress");
    } finally { sse.abort(); }
  });
});
