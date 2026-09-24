import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { bech32 } from "@scure/base";
import { createHash } from "node:crypto";
import { createServer, type ServerDeps } from "../src/server.js";
import { MemorySettlementStore } from "../src/settlement-store.js";
import type { LnurlServiceConfig } from "../src/types/index.js";
import { openVerifyBatchStream } from "../packages/client/src/index.js";

const CONFIG: LnurlServiceConfig = { port: 0, baseUrl: "", minSendable: 1_000, maxSendable: 100_000_000, invoiceTimeoutMs: 3_000 };

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

function startServer(deps?: ServerDeps, verifyBatch?: LnurlServiceConfig["verifyBatch"]) {
  const server = http.createServer();
  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${port}`;
      server.on("request", createServer({ ...CONFIG, baseUrl, ...(verifyBatch ? { verifyBatch } : {}) }, deps));
      resolve({ baseUrl, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) });
    });
  });
}

type Session = { sessionId: string; token: string; response: http.IncomingMessage; abort: () => void };

function openSession(baseUrl: string): Promise<Session> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}/lnurl/session`, { method: "POST" });
    req.on("response", (res) => {
      let buf = "";
      const onData = (c: Buffer) => {
        buf += c.toString();
        for (const line of buf.split("\n")) {
          if (line.startsWith("data: ")) {
            const d = JSON.parse(line.slice(6)) as { sessionId?: string; token?: string };
            if (d.sessionId && d.token) {
              res.removeListener("data", onData);
              resolve({ sessionId: d.sessionId, token: d.token, response: res, abort: () => { res.destroy(); req.destroy(); } });
              return;
            }
          }
        }
      };
      res.on("data", onData);
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

/** Waits for the next named SSE event on an open session stream. */
function nextSseEvent(res: http.IncomingMessage, timeoutMs = 5000) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for SSE event")), timeoutMs);
    let buf = "";
    const onData = (c: Buffer) => {
      buf += c.toString();
      for (const line of buf.split("\n")) {
        if (line.startsWith("data: ")) {
          clearTimeout(timer);
          res.removeListener("data", onData);
          resolve(JSON.parse(line.slice(6)));
          return;
        }
      }
    };
    res.on("data", onData);
  });
}

/** Validates and POSTs the invoice to the wallet API, then unblocks the callback. */
async function requestInvoice(baseUrl: string, session: Session, pr: string) {
  const evt = nextSseEvent(session.response);
  const payer = jsonRequest(`${baseUrl}/lnurl/${session.sessionId}/callback?amount=50000`);
  await evt;
  await jsonRequest(`${baseUrl}/lnurl/session/${session.sessionId}/invoice`, "POST", { pr }, session.token);
  return payer;
}

async function jsonRequest(url: string, method = "GET", body?: unknown, token?: string) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const req = http.request(url, { method, headers }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: d ? JSON.parse(d) : {} }));
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

type BatchEvent = { event: string; data: Record<string, unknown> };

/** Parses a batch stream frame by frame, tracking the event name ("" = results). */
class EventReader {
  private pending: BatchEvent[] = [];
  private waiters: ((e: BatchEvent) => void)[] = [];
  private closed = false;
  constructor(private res: http.IncomingMessage) {
    let buf = "";
    let evt = "";
    res.on("data", (c: Buffer) => {
      buf += c.toString();
      for (;;) {
        const end = buf.indexOf("\n\n");
        if (end === -1) break;
        const frame = buf.slice(0, end);
        buf = buf.slice(end + 2);
        let dataLine: string | undefined;
        for (const line of frame.split("\n")) {
          if (line.startsWith("event: ")) evt = line.slice(7).trim();
          else if (line.startsWith("data: ")) dataLine = line.slice(6);
        }
        if (!dataLine) continue; // ": keepalive" comment lines carry no data
        const parsed: BatchEvent = { event: evt, data: JSON.parse(dataLine) as Record<string, unknown> };
        evt = "";
        const waiter = this.waiters.shift();
        if (waiter) waiter(parsed);
        else this.pending.push(parsed);
      }
    });
    res.on("end", () => { this.closed = true; });
    res.on("close", () => { this.closed = true; });
  }
  next(timeoutMs = 5_000): Promise<BatchEvent> {
    const queued = this.pending.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.reject(new Error("Stream ended"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for a batch frame")), timeoutMs);
      this.waiters.push((evt) => {
        clearTimeout(timer);
        resolve(evt);
      });
    });
  }
  close(): void {
    this.res.destroy();
  }
}

function openBatchStream(url: string): Promise<{ reader: EventReader }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { headers: { Accept: "text/event-stream" } });
    req.on("response", (res) => resolve({ reader: new EventReader(res) }));
    req.on("error", reject);
    req.end();
  });
}

const KNOWN_HASH = "ab".repeat(32);
const VERIFY_ID = "01".repeat(16);
const verifyUrl = (base: string, key: string) => `${base}/lnurl/verify/${key}`;

function seededStore(): MemorySettlementStore {
  const store = new MemorySettlementStore(86_400_000);
  store.create({ paymentHash: KNOWN_HASH, pr: "lnbc1known", sessionId: "s" });
  store.create({ paymentHash: VERIFY_ID, pr: "", sessionId: "s", paymentOption: "arkade", paymentDestination: "tark1dest", amountMsat: 50_000 });
  return store;
}

describe("LUD-XX verifyBatch — discovery", () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;
  beforeEach(async () => { ctx = await startServer(); });
  afterEach(async () => { await ctx.close(); });

  it("callback and verify responses advertise the batch endpoint", async () => {
    const session = await openSession(ctx.baseUrl);
    try {
      const payer = requestInvoice(ctx.baseUrl, session, buildInvoice(KNOWN_HASH));
      const res = await payer;
      expect(res.body.verify).toBe(`${ctx.baseUrl}/lnurl/verify/${KNOWN_HASH}`);
      expect(res.body.verifyBatch).toBe(`${ctx.baseUrl}/lnurl/verifyBatch`);
      const verify = await jsonRequest(`${ctx.baseUrl}/lnurl/verify/${KNOWN_HASH}`);
      expect(verify.body.verifyBatch).toBe(`${ctx.baseUrl}/lnurl/verifyBatch`);
      expect(verify.body.status).toBe("OK");
      expect(verify.body.settled).toBe(false);
    } finally {
      session.abort();
    }
  });
});

describe("LUD-XX verifyBatch — one-shot snapshot", () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;
  beforeEach(async () => {
    ctx = await startServer({ settlements: seededStore() } as unknown as ServerDeps);
  });
  afterEach(async () => { await ctx.close(); });

  it("rejects a request with no verify parameter (400)", async () => {
    const res = await jsonRequest(`${ctx.baseUrl}/lnurl/verifyBatch`);
    expect(res.status).toBe(400);
    expect(res.body.status).toBe("ERROR");
  });

  it("answers bolt11, destination and unknown entries keyed by the exact presented strings", async () => {
    const unknown = verifyUrl(ctx.baseUrl, "ff".repeat(32));
    const bolt = verifyUrl(ctx.baseUrl, KNOWN_HASH);
    const arkade = verifyUrl(ctx.baseUrl, VERIFY_ID);
    // A payer may copy the hash upper-case out of their own invoice: the key
    // normalizes, the echo keeps the exact presented string.
    const upperBolt = verifyUrl(ctx.baseUrl, KNOWN_HASH.toUpperCase());
    const res = await jsonRequest(
      `${ctx.baseUrl}/lnurl/verifyBatch?verify=${encodeURIComponent(bolt)}` +
      `&verify=${encodeURIComponent(unknown)}&verify=${encodeURIComponent(arkade)}` +
      `&verify=${encodeURIComponent(upperBolt)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("OK");
    const results = res.body.results as Record<string, Record<string, unknown>>;
    expect(Object.keys(results)).toHaveLength(4);
    expect(results[bolt]).toMatchObject({ status: "OK", settled: false, preimage: null, pr: "lnbc1known" });
    expect(results[unknown]).toEqual({ status: "ERROR", reason: "unknown verify url" });
    expect(results[arkade]).toMatchObject({ status: "OK", settled: false, paymentOption: "arkade", paymentDestination: "tark1dest", paymentReference: null });
    expect(results[upperBolt]).toMatchObject({ status: "OK", settled: false, pr: "lnbc1known" });
  });

  it("answers an oversized set with 414, the status clients split on", async () => {
    const res = await jsonRequest(`${ctx.baseUrl}/lnurl/verifyBatch?${"verify=a&".repeat(251)}`);
    expect(res.status).toBe(414);
    expect(res.body.status).toBe("ERROR");
  });

  it("answers a presented URL that collides with an Object.prototype key", async () => {
    const res = await jsonRequest(`${ctx.baseUrl}/lnurl/verifyBatch?verify=__proto__&verify=constructor`);
    expect(res.status).toBe(200);
    const results = res.body.results as Record<string, unknown>;
    expect(Object.keys(results).sort()).toEqual(["__proto__", "constructor"]);
    expect(results["constructor"]).toEqual({ status: "ERROR", reason: "unknown verify url" });
  });
});

describe("LUD-XX verifyBatch — client against the real server", () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;
  beforeEach(async () => {
    ctx = await startServer({ settlements: seededStore() } as unknown as ServerDeps);
  });
  afterEach(async () => { await ctx.close(); });

  it("openVerifyBatchStream presents its verify set and receives the snapshot", async () => {
    const bolt = verifyUrl(ctx.baseUrl, KNOWN_HASH);
    const updates: [string, unknown][] = [];
    const errors: unknown[] = [];
    const stream = openVerifyBatchStream(
      { verifyBatchUrl: `${ctx.baseUrl}/lnurl/verifyBatch`, verifyUrls: [bolt] },
      { onUpdate: (url, status) => updates.push([url, status]), onError: (e) => errors.push(e) },
    );
    try {
      await expect.poll(() => updates.length + errors.length, { timeout: 5_000 }).toBeGreaterThan(0);
      expect(errors).toEqual([]);
      expect(updates[0]).toEqual([bolt, expect.objectContaining({ settled: false })]);
      expect(stream.sessionId).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      stream.close();
    }
  });
});

describe("LUD-XX verifyBatch — stream", () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;
  beforeEach(async () => {
    ctx = await startServer({ settlements: seededStore() } as unknown as ServerDeps);
  });
  afterEach(async () => { await ctx.close(); });

  it("emits the session frame then one result frame per distinct URL, unknown included", async () => {
    const unknown = verifyUrl(ctx.baseUrl, "ff".repeat(32));
    const bolt = verifyUrl(ctx.baseUrl, KNOWN_HASH);
    const batch = await openBatchStream(`${ctx.baseUrl}/lnurl/verifyBatch?verify=${encodeURIComponent(bolt)}&verify=${encodeURIComponent(unknown)}&verify=${encodeURIComponent(bolt)}`);
    try {
      const opened = await batch.reader.next();
      expect(opened.event).toBe("session");
      expect(typeof opened.data.session).toBe("string");
      const boltFrame = await batch.reader.next();
      expect(boltFrame.event).toBe("");
      expect(boltFrame.data).toMatchObject({ verify: bolt, settled: false, pr: "lnbc1known" });
      const unknownFrame = await batch.reader.next();
      expect(unknownFrame.event).toBe("");
      // Error frames carry the verify field like every other result frame.
      expect(unknownFrame.data).toMatchObject({ status: "ERROR", reason: "unknown verify url" });
      // The duplicate URL was collapsed: nothing further arrives as unknown.
      const idle = openBatchStreamReaderIdle(batch.reader);
      await expect(idle).resolves.toBeUndefined();
    } finally {
      batch.reader.close();
      await ctx.close();
    }
  });

  it("pushes a settlement the moment the session reports it, then closes", async () => {
    const session = await openSession(ctx.baseUrl);
    // Not pre-seeded: this stream's record is minted by the callback itself,
    // so its sessionId matches the replying session.
    const preimage = "22".repeat(32);
    const minted = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
    const bolt = verifyUrl(ctx.baseUrl, minted);
    const wallet = requestInvoice(ctx.baseUrl, session, buildInvoice(minted));
    expect(((await wallet).body)).toMatchObject({ verify: bolt });
    // Presented AFTER the record exists: an unknown snapshot would have been
    // terminal and closed the stream instead of waiting for the flip.
    const batch = await openBatchStream(`${ctx.baseUrl}/lnurl/verifyBatch?verify=${encodeURIComponent(bolt)}`);
    try {
      void batch.reader.next(); // session frame
      void batch.reader.next(); // snapshot frame (unsettled)
      const settled = await jsonRequest(`${ctx.baseUrl}/lnurl/session/${session.sessionId}/settled`, "POST", { preimage }, session.token);
      expect(settled.status).toBe(200);
      const flip = await batch.reader.next(5_000);
      expect(flip.event).toBe("");
      expect(flip.data).toMatchObject({ verify: bolt, settled: true, preimage });
    } finally {
      session.abort();
      batch.reader.close();
      await ctx.close();
    }
  });
});

describe("LUD-XX verifyBatch — session updates and caps", () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;
  afterEach(async () => { await ctx.close(); });
  const q = (u: string) => encodeURIComponent(u);

  async function openWithSession(url: string) {
    const batch = await openBatchStream(url);
    const opened = await batch.reader.next();
    expect(opened.event).toBe("session");
    return { reader: batch.reader, session: opened.data.session as string };
  }

  it("adds and removes tracked URLs in place, and answers the update with OK", async () => {
    ctx = await startServer({ settlements: seededStore() } as unknown as ServerDeps);
    const bolt = verifyUrl(ctx.baseUrl, KNOWN_HASH);
    const arkade = verifyUrl(ctx.baseUrl, VERIFY_ID);
    const { reader, session } = await openWithSession(`${ctx.baseUrl}/lnurl/verifyBatch?verify=${q(bolt)}`);
    try {
      await reader.next(); // bolt snapshot
      const update = await jsonRequest(`${ctx.baseUrl}/lnurl/verifyBatch?session=${session}&add=${q(arkade)}&remove=${q(bolt)}`);
      expect(update).toEqual({ status: 200, body: { status: "OK" } });
      const frames = [await reader.next(), await reader.next()];
      expect(frames).toContainEqual({ event: "removed", data: { verify: bolt } });
      expect(frames).toContainEqual({ event: "", data: expect.objectContaining({ verify: arkade, paymentOption: "arkade" }) });
      const replay = await jsonRequest(`${ctx.baseUrl}/lnurl/verifyBatch?session=${session}&add=${q(arkade)}&remove=${q(bolt)}`);
      expect(replay.status).toBe(200);
      await expect(openBatchStreamReaderIdle(reader)).resolves.toBeUndefined();
    } finally {
      reader.close();
    }
  });

  it("refuses an update with nothing to do, and one for a closed session", async () => {
    ctx = await startServer({ settlements: seededStore() } as unknown as ServerDeps);
    const bolt = verifyUrl(ctx.baseUrl, KNOWN_HASH);
    const { reader, session } = await openWithSession(`${ctx.baseUrl}/lnurl/verifyBatch?verify=${q(bolt)}`);
    expect((await jsonRequest(`${ctx.baseUrl}/lnurl/verifyBatch?session=${session}`)).status).toBe(400);
    reader.close();
    await expect.poll(async () => (await jsonRequest(`${ctx.baseUrl}/lnurl/verifyBatch?session=${session}&add=${q(bolt)}`)).status, { timeout: 5_000 }).toBe(404);
  });

  it("caps tracked URLs per stream: 414 at open, 400 on an update, leaving the set unchanged", async () => {
    ctx = await startServer({ settlements: seededStore() } as unknown as ServerDeps, { maxTracked: 1 });
    const bolt = verifyUrl(ctx.baseUrl, KNOWN_HASH);
    const arkade = verifyUrl(ctx.baseUrl, VERIFY_ID);
    const { reader, session } = await openWithSession(`${ctx.baseUrl}/lnurl/verifyBatch?verify=${q(bolt)}`);
    try {
      await reader.next();
      expect((await jsonRequest(`${ctx.baseUrl}/lnurl/verifyBatch?session=${session}&add=${q(arkade)}`)).status).toBe(400);
      await expect(openBatchStreamReaderIdle(reader)).resolves.toBeUndefined();
    } finally {
      reader.close();
    }
    const status = await new Promise<number>((resolve) => {
      http.get(`${ctx.baseUrl}/lnurl/verifyBatch?verify=${q(bolt)}&verify=${q(arkade)}`, { headers: { Accept: "text/event-stream" } }, (res) => { resolve(res.statusCode ?? 0); res.destroy(); });
    });
    expect(status).toBe(414);
  });

  it("caps concurrent streams with 429", async () => {
    ctx = await startServer({ settlements: seededStore() } as unknown as ServerDeps, { maxSessions: 1 });
    const bolt = verifyUrl(ctx.baseUrl, KNOWN_HASH);
    const first = await openWithSession(`${ctx.baseUrl}/lnurl/verifyBatch?verify=${q(bolt)}`);
    try {
      const status = await new Promise<number>((resolve) => {
        http.get(`${ctx.baseUrl}/lnurl/verifyBatch?verify=${q(bolt)}`, { headers: { Accept: "text/event-stream" } }, (res) => { resolve(res.statusCode ?? 0); res.destroy(); });
      });
      expect(status).toBe(429);
    } finally {
      first.reader.close();
    }
  });
});

async function openBatchStreamReaderIdle(reader: EventReader, timeoutMs = 1_500): Promise<void> {
  try {
    await reader.next(timeoutMs);
  } catch {
    return;
  }
  throw new Error("Unexpected extra frame collapsed");
}
