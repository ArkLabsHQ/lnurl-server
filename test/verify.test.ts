import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { bech32 } from "@scure/base";
import { createHash } from "node:crypto";
import { createServer, type ServerDeps } from "../src/server.js";
import type { LnurlServiceConfig } from "../src/types.js";

const CONFIG: LnurlServiceConfig = { port: 0, baseUrl: "", minSendable: 1_000, maxSendable: 100_000_000, invoiceTimeoutMs: 3_000 };

/** Structurally-valid bolt11 whose payment-hash field is `paymentHashHex` (signature is dummy). */
function buildInvoice(paymentHashHex: string): string {
  const words: number[] = [];
  for (let i = 0; i < 7; i++) words.push(0);
  const desc = bech32.toWords(new TextEncoder().encode("hello"));
  words.push(13, desc.length >> 5, desc.length & 31, ...desc);
  const hw = bech32.toWords(Uint8Array.from(Buffer.from(paymentHashHex, "hex")));
  words.push(1, 52 >> 5, 52 & 31, ...hw);
  for (let i = 0; i < 104; i++) words.push(0);
  return bech32.encode("lnbc", words, 2000);
}

function startServer(deps?: ServerDeps) {
  const server = http.createServer();
  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${port}`;
      server.on("request", createServer({ ...CONFIG, baseUrl }, deps));
      resolve({ baseUrl, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) });
    });
  });
}

function openSession(baseUrl: string) {
  return new Promise<{ sessionId: string; token: string; response: http.IncomingMessage; abort: () => void }>((resolve, reject) => {
    const req = http.request(`${baseUrl}/lnurl/session`, { method: "POST" });
    req.on("response", (res) => {
      let buf = "";
      const onData = (c: Buffer) => {
        buf += c.toString();
        for (const line of buf.split("\n")) {
          if (line.startsWith("data: ")) {
            const d = JSON.parse(line.slice(6));
            if (d.sessionId && d.token) {
              res.removeListener("data", onData);
              resolve({ sessionId: d.sessionId, token: d.token, response: res, abort: () => { res.destroy(); req.destroy(); } });
              return;
            }
          }
        }
      };
      res.on("data", onData); res.on("error", reject);
    });
    req.on("error", reject); req.end();
  });
}

function nextSseEvent(res: http.IncomingMessage, timeoutMs = 5000) {
  return new Promise<{ event: string; data: Record<string, unknown> }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for SSE event")), timeoutMs);
    let buf = "";
    const onData = (c: Buffer) => {
      buf += c.toString();
      let evt = "";
      for (const line of buf.split("\n")) {
        if (line.startsWith("event: ")) evt = line.slice(7).trim();
        if (line.startsWith("data: ") && evt) { clearTimeout(timer); res.removeListener("data", onData); resolve({ event: evt, data: JSON.parse(line.slice(6)) }); return; }
      }
    };
    res.on("data", onData);
  });
}

function jsonRequest(url: string, method = "GET", body?: unknown, token?: string) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const req = http.request(url, { method, headers }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: d ? JSON.parse(d) : {} }));
    });
    req.on("error", reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
}

describe("LUD-21 verify — emission", () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;
  beforeEach(async () => { ctx = await startServer(); });
  afterEach(async () => { await ctx.close(); });

  it("adds a verify url to the callback and reports unsettled before payment", async () => {
    const session = await openSession(ctx.baseUrl);
    try {
      const hash = createHash("sha256").update(Buffer.from("11".repeat(32), "hex")).digest("hex");
      const evt = nextSseEvent(session.response);
      const payer = jsonRequest(`${ctx.baseUrl}/lnurl/${session.sessionId}/callback?amount=50000`);
      await evt;
      await jsonRequest(`${ctx.baseUrl}/lnurl/session/${session.sessionId}/invoice`, "POST", { pr: buildInvoice(hash) }, session.token);
      const res = await payer;

      expect(res.body.pr).toBe(buildInvoice(hash));
      expect(res.body.verify).toBe(`${ctx.baseUrl}/lnurl/verify/${hash}`);

      const v = await jsonRequest(`${ctx.baseUrl}/lnurl/verify/${hash}`);
      expect(v.body).toMatchObject({ status: "OK", settled: false, preimage: null, pr: buildInvoice(hash) });
    } finally { session.abort(); }
  });

  it("omits verify (but still returns pr) when the bolt11 can't be decoded", async () => {
    const session = await openSession(ctx.baseUrl);
    try {
      const evt = nextSseEvent(session.response);
      const payer = jsonRequest(`${ctx.baseUrl}/lnurl/${session.sessionId}/callback?amount=50000`);
      await evt;
      await jsonRequest(`${ctx.baseUrl}/lnurl/session/${session.sessionId}/invoice`, "POST", { pr: "lnbc1notdecodable" }, session.token);
      const res = await payer;
      expect(res.body.pr).toBe("lnbc1notdecodable");
      expect(res.body.verify).toBeUndefined();
    } finally { session.abort(); }
  });

  it("returns ERROR for an unknown payment hash", async () => {
    const v = await jsonRequest(`${ctx.baseUrl}/lnurl/verify/${"00".repeat(32)}`);
    expect(v.body.status).toBe("ERROR");
  });
});

export { buildInvoice, startServer, openSession, nextSseEvent, jsonRequest };
