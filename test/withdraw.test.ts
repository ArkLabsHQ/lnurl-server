import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { createServer } from "../src/server.js";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import type { LnurlServiceConfig } from "../src/types.js";

const CONFIG: LnurlServiceConfig = { port: 0, baseUrl: "", minSendable: 1000, maxSendable: 100_000_000, invoiceTimeoutMs: 3000 };
let db: Db; let repos: Repositories; let ctx: { baseUrl: string; close: () => Promise<void> };

function start() {
  const server = http.createServer();
  return new Promise<typeof ctx>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.on("request", createServer({ ...CONFIG, baseUrl: `http://127.0.0.1:${port}` }, { repos }));
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) });
    });
  });
}
function jsonReq(method: string, url: string, body?: unknown, bearer?: string) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const r = http.request(url, { method, headers }, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: d ? JSON.parse(d) : {} })); });
    r.on("error", reject); if (body) r.write(JSON.stringify(body)); r.end();
  });
}
function getJson(url: string) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    http.get(url, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(JSON.parse(d))); }).on("error", reject);
  });
}
function openSse(baseUrl: string, token: string) {
  return new Promise<{ res: http.IncomingMessage; sessionId: string; abort: () => void }>((resolve, reject) => {
    const req = http.request(`${baseUrl}/lnurl/session`, { method: "POST", headers: { "Content-Type": "application/json" } });
    req.on("response", (res) => {
      let buf = "";
      const onData = (c: Buffer) => {
        buf += c.toString();
        const m = buf.match(/"sessionId":"([0-9a-f]+)"/);
        if (m) { res.off("data", onData); resolve({ res, sessionId: m[1], abort: () => { res.destroy(); req.destroy(); } }); }
      };
      res.on("data", onData); res.on("error", reject);
    });
    req.on("error", reject); req.write(JSON.stringify({ token })); req.end();
  });
}

const TOKEN = "ab".repeat(32);
beforeEach(async () => { db = openDb(":memory:"); runMigrations(db); repos = createRepositories(db); ctx = await start(); });
afterEach(async () => { await ctx.close(); db.close(); });

describe("withdraw", () => {
  it("rejects create with min > max", async () => {
    const sse = await openSse(ctx.baseUrl, TOKEN);
    try {
      const res = await jsonReq("POST", `${ctx.baseUrl}/lnurl/session/${sse.sessionId}/withdraw`, { minWithdrawable: 5000, maxWithdrawable: 1000 }, TOKEN);
      expect(res.status).toBe(400);
    } finally { sse.abort(); }
  });

  it("creates a link and serves LUD-03 withdrawRequest metadata", async () => {
    const sse = await openSse(ctx.baseUrl, TOKEN);
    try {
      const created = await jsonReq("POST", `${ctx.baseUrl}/lnurl/session/${sse.sessionId}/withdraw`, { minWithdrawable: 1000, maxWithdrawable: 50000, description: "tip jar" }, TOKEN);
      expect(created.status).toBe(201);
      const meta = await getJson(`${ctx.baseUrl}/lnurl/withdraw/${created.body.withdrawId}`);
      expect(meta.tag).toBe("withdrawRequest");
      expect(meta.k1).toBe(created.body.withdrawId);
      expect(meta.maxWithdrawable).toBe(50000);
    } finally { sse.abort(); }
  });

  it("errors on callback when funding wallet is offline", async () => {
    repos.withdrawals.create({ id: "wOff", sessionId: "deadsession", minWithdrawable: 1000, maxWithdrawable: 50000 });
    const res = await getJson(`${ctx.baseUrl}/lnurl/withdraw/wOff/callback?k1=wOff&pr=lnbc1payme`);
    expect(res.status).toBe("ERROR");
    expect(String(res.reason)).toMatch(/offline/i);
  });

  it("completes a full withdraw round-trip", async () => {
    const sse = await openSse(ctx.baseUrl, TOKEN);
    try {
      const created = await jsonReq("POST", `${ctx.baseUrl}/lnurl/session/${sse.sessionId}/withdraw`, { minWithdrawable: 1000, maxWithdrawable: 50000 }, TOKEN);
      const wid = created.body.withdrawId as string;

      // Withdrawer hits the callback with a bolt11 (this HTTP call stays pending until the wallet confirms)
      const callbackPromise = getJson(`${ctx.baseUrl}/lnurl/withdraw/${wid}/callback?k1=${wid}&pr=lnbc1payme`);

      // Funding wallet receives withdraw_request via SSE, pays, and confirms
      await new Promise((r) => setTimeout(r, 100));
      const confirm = await jsonReq("POST", `${ctx.baseUrl}/lnurl/session/${sse.sessionId}/withdraw/${wid}`, { status: "paid" }, TOKEN);
      expect(confirm.status).toBe(200);

      const cb = await callbackPromise;
      expect(cb.status).toBe("OK");
      expect(repos.withdrawals.get(wid)!.status).toBe("used");
    } finally { sse.abort(); }
  });

  it("wallet-reject: callback resolves with ERROR and withdrawal stays active", async () => {
    const sse = await openSse(ctx.baseUrl, TOKEN);
    try {
      const created = await jsonReq("POST", `${ctx.baseUrl}/lnurl/session/${sse.sessionId}/withdraw`, { minWithdrawable: 1000, maxWithdrawable: 50000 }, TOKEN);
      const wid = created.body.withdrawId as string;

      // Withdrawer hits the callback (stays pending while wallet decides)
      const callbackPromise = getJson(`${ctx.baseUrl}/lnurl/withdraw/${wid}/callback?k1=${wid}&pr=lnbc1payme`);

      // Funding wallet rejects with an error
      await new Promise((r) => setTimeout(r, 100));
      const reject = await jsonReq("POST", `${ctx.baseUrl}/lnurl/session/${sse.sessionId}/withdraw/${wid}`, { error: "amount out of range" }, TOKEN);
      expect(reject.status).toBe(200);

      const cb = await callbackPromise;
      expect(cb.status).toBe("ERROR");
      expect(String(cb.reason)).toMatch(/amount out of range/);
      // markUsed must NOT have been called — row stays active
      expect(repos.withdrawals.get(wid)!.status).toBe("active");
    } finally { sse.abort(); }
  });

  it("rejects create with usesRemaining 0", async () => {
    const sse = await openSse(ctx.baseUrl, TOKEN);
    try {
      const res = await jsonReq("POST", `${ctx.baseUrl}/lnurl/session/${sse.sessionId}/withdraw`, { minWithdrawable: 1000, maxWithdrawable: 50000, usesRemaining: 0 }, TOKEN);
      expect(res.status).toBe(400);
    } finally { sse.abort(); }
  });

  it("rejects create with past expiresAt", async () => {
    const sse = await openSse(ctx.baseUrl, TOKEN);
    try {
      const res = await jsonReq("POST", `${ctx.baseUrl}/lnurl/session/${sse.sessionId}/withdraw`, { minWithdrawable: 1000, maxWithdrawable: 50000, expiresAt: 1 }, TOKEN);
      expect(res.status).toBe(400);
    } finally { sse.abort(); }
  });
});
