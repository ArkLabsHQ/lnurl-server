import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { createServer } from "../src/server.js";
import type { LnurlServiceConfig } from "../src/types.js";

const BASE_URL = "http://localhost:0"; // placeholder, overridden per test
const CONFIG: LnurlServiceConfig = {
  port: 0,
  baseUrl: "", // set dynamically per test
  minSendable: 1_000, // 1 sat
  maxSendable: 100_000_000, // 100k sats
  invoiceTimeoutMs: 3_000,
};

/**
 * Helper: start the express app on a random port, return address + cleanup.
 */
function startServer() {
  const server = http.createServer();
  const config = { ...CONFIG };

  return new Promise<{
    baseUrl: string;
    server: http.Server;
    config: LnurlServiceConfig;
    close: () => Promise<void>;
  }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      config.baseUrl = baseUrl;

      const app = createServer(config);
      server.removeAllListeners("request");
      server.on("request", app);

      resolve({
        baseUrl,
        server,
        config,
        close: () =>
          new Promise<void>((res) => {
            server.closeAllConnections();
            server.close(() => res());
          }),
      });
    });
  });
}

/**
 * Helper: open an SSE session and return session info.
 * Pass `credentials` to create a deterministic/reusable session.
 */
async function openSession(
  baseUrl: string,
  credentials?: { sessionId: string; token: string },
): Promise<{
  sessionId: string;
  lnurl: string;
  token: string;
  response: http.IncomingMessage;
  abort: () => void;
}> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    let body: string | undefined;
    if (credentials) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(credentials);
    }

    const req = http.request(`${baseUrl}/lnurl/session`, {
      method: "POST",
      headers,
    });

    req.on("response", (res) => {
      let buffer = "";

      const onData = (chunk: Buffer) => {
        buffer += chunk.toString();

        // Parse SSE events from buffer
        const lines = buffer.split("\n");
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i];
          if (line.startsWith("data: ")) {
            const data = JSON.parse(line.slice(6));
            if (data.sessionId && data.lnurl && data.token) {
              // Stop listening for initial event, keep stream open
              res.removeListener("data", onData);
              resolve({
                sessionId: data.sessionId,
                lnurl: data.lnurl,
                token: data.token,
                response: res,
                abort: () => {
                  res.destroy();
                  req.destroy();
                },
              });
              return;
            }
          }
        }
      };

      res.on("data", onData);
      res.on("error", reject);
    });

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Helper: collect the next SSE event from an open stream.
 */
function nextSseEvent(
  res: http.IncomingMessage,
  timeoutMs = 5000,
): Promise<{ event: string; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for SSE event")),
      timeoutMs,
    );
    let buffer = "";

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");

      let eventType = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7).trim();
        }
        if (line.startsWith("data: ") && eventType) {
          clearTimeout(timer);
          res.removeListener("data", onData);
          resolve({ event: eventType, data: JSON.parse(line.slice(6)) });
          return;
        }
      }
    };

    res.on("data", onData);
  });
}

/**
 * Helper: make a JSON request.
 */
async function jsonRequest(
  url: string,
  method = "GET",
  body?: unknown,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const opts: http.RequestOptions = {
      method,
      headers,
    };

    const req = http.request(url, opts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: JSON.parse(data),
        });
      });
    });

    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("LNURL Service", () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;

  beforeEach(async () => {
    ctx = await startServer();
  });

  afterEach(async () => {
    await ctx.close();
  });

  describe("POST /lnurl/session", () => {
    it("should open SSE stream and return session_created event with lnurl", async () => {
      const session = await openSession(ctx.baseUrl);
      try {
        expect(session.sessionId).toBeTruthy();
        expect(session.sessionId).toHaveLength(32); // 16 bytes hex
        expect(session.lnurl).toMatch(/^LNURL/);
      } finally {
        session.abort();
      }
    });
  });

  describe("GET /lnurl/:id (LNURL-pay metadata)", () => {
    it("should return pay metadata for active session", async () => {
      const session = await openSession(ctx.baseUrl);
      try {
        const res = await jsonRequest(
          `${ctx.baseUrl}/lnurl/${session.sessionId}`,
        );

        expect(res.status).toBe(200);
        expect(res.body.tag).toBe("payRequest");
        expect(res.body.minSendable).toBe(CONFIG.minSendable);
        expect(res.body.maxSendable).toBe(CONFIG.maxSendable);
        expect(res.body.callback).toBe(
          `${ctx.baseUrl}/lnurl/${session.sessionId}/callback`,
        );
        expect(typeof res.body.metadata).toBe("string");
        expect(res.body.commentAllowed).toBe(140);
      } finally {
        session.abort();
      }
    });

    it("should return error for inactive/unknown session", async () => {
      const res = await jsonRequest(`${ctx.baseUrl}/lnurl/nonexistent`);

      expect(res.status).toBe(200); // LNURL spec: errors are 200 with status: ERROR
      expect(res.body.status).toBe("ERROR");
      expect(res.body.reason).toMatch(/no longer active/i);
    });

    it("should return error after session is closed", async () => {
      const session = await openSession(ctx.baseUrl);
      session.abort();

      // Small delay for cleanup
      await new Promise((r) => setTimeout(r, 100));

      const res = await jsonRequest(
        `${ctx.baseUrl}/lnurl/${session.sessionId}`,
      );
      expect(res.body.status).toBe("ERROR");
    });
  });

  describe("GET /lnurl/:id/callback (LNURL-pay callback)", () => {
    it("should return error when amount is missing", async () => {
      const session = await openSession(ctx.baseUrl);
      try {
        const res = await jsonRequest(
          `${ctx.baseUrl}/lnurl/${session.sessionId}/callback`,
        );
        expect(res.body.status).toBe("ERROR");
        expect(res.body.reason).toMatch(/missing|invalid/i);
      } finally {
        session.abort();
      }
    });

    it("should return error when amount is below minimum", async () => {
      const session = await openSession(ctx.baseUrl);
      try {
        const res = await jsonRequest(
          `${ctx.baseUrl}/lnurl/${session.sessionId}/callback?amount=500`,
        );
        expect(res.body.status).toBe("ERROR");
        expect(res.body.reason).toMatch(/between/i);
      } finally {
        session.abort();
      }
    });

    it("should return error when amount is above maximum", async () => {
      const session = await openSession(ctx.baseUrl);
      try {
        const res = await jsonRequest(
          `${ctx.baseUrl}/lnurl/${session.sessionId}/callback?amount=999999999999`,
        );
        expect(res.body.status).toBe("ERROR");
        expect(res.body.reason).toMatch(/between/i);
      } finally {
        session.abort();
      }
    });

    it("should return error for inactive session", async () => {
      const res = await jsonRequest(
        `${ctx.baseUrl}/lnurl/nonexistent/callback?amount=50000`,
      );
      expect(res.body.status).toBe("ERROR");
      expect(res.body.reason).toMatch(/no longer active/i);
    });

    it("should timeout if wallet does not respond", async () => {
      const session = await openSession(ctx.baseUrl);
      try {
        // Don't respond to the invoice request — let it timeout
        const res = await jsonRequest(
          `${ctx.baseUrl}/lnurl/${session.sessionId}/callback?amount=50000`,
        );
        expect(res.body.status).toBe("ERROR");
        expect(res.body.reason).toMatch(/timed out/i);
      } finally {
        session.abort();
      }
    });
  });

  describe("Full invoice flow", () => {
    it("should deliver bolt11 from wallet to payer", async () => {
      const session = await openSession(ctx.baseUrl);
      const fakeBolt11 = "lnbc500n1fakeinvoice";

      try {
        // Listen for the SSE invoice_request event
        const eventPromise = nextSseEvent(session.response);

        // Payer requests invoice (runs concurrently)
        const payerPromise = jsonRequest(
          `${ctx.baseUrl}/lnurl/${session.sessionId}/callback?amount=50000&comment=test`,
        );

        // Wait for wallet to receive the invoice request via SSE
        const event = await eventPromise;
        expect(event.event).toBe("invoice_request");
        expect(event.data.amountMsat).toBe(50000);
        expect(event.data.comment).toBe("test");

        // Wallet creates swap and posts bolt11 back (with auth token)
        const invoiceRes = await jsonRequest(
          `${ctx.baseUrl}/lnurl/session/${session.sessionId}/invoice`,
          "POST",
          { pr: fakeBolt11 },
          session.token,
        );
        expect(invoiceRes.status).toBe(200);
        expect(invoiceRes.body.ok).toBe(true);

        // Payer should now get the bolt11
        const payerRes = await payerPromise;
        expect(payerRes.status).toBe(200);
        expect(payerRes.body.pr).toBe(fakeBolt11);
        expect(payerRes.body.routes).toEqual([]);
      } finally {
        session.abort();
      }
    });

    it("should reject duplicate invoice requests", async () => {
      const session = await openSession(ctx.baseUrl);
      try {
        // Start first invoice request (will hang waiting for wallet)
        const firstReq = jsonRequest(
          `${ctx.baseUrl}/lnurl/${session.sessionId}/callback?amount=50000`,
        );

        // Wait a bit for the first request to register
        await new Promise((r) => setTimeout(r, 100));

        // Second request should fail
        const secondRes = await jsonRequest(
          `${ctx.baseUrl}/lnurl/${session.sessionId}/callback?amount=50000`,
        );
        expect(secondRes.body.status).toBe("ERROR");
        expect(secondRes.body.reason).toMatch(/already pending/i);

        // Clean up first request (let it timeout or abort)
        session.abort();
        await firstReq.catch(() => {}); // swallow abort error
      } finally {
        session.abort();
      }
    });
  });

  describe("POST /lnurl/session/:id/invoice", () => {
    it("should return 401 without auth token", async () => {
      const session = await openSession(ctx.baseUrl);
      try {
        const res = await jsonRequest(
          `${ctx.baseUrl}/lnurl/session/${session.sessionId}/invoice`,
          "POST",
          { pr: "lnbc1test" },
        );
        expect(res.status).toBe(401);
        expect(res.body.error).toMatch(/unauthorized/i);
      } finally {
        session.abort();
      }
    });

    it("should return 401 with wrong token", async () => {
      const session = await openSession(ctx.baseUrl);
      try {
        const res = await jsonRequest(
          `${ctx.baseUrl}/lnurl/session/${session.sessionId}/invoice`,
          "POST",
          { pr: "lnbc1test" },
          "wrong-token",
        );
        expect(res.status).toBe(401);
      } finally {
        session.abort();
      }
    });

    it("should return 400 when pr is missing", async () => {
      const session = await openSession(ctx.baseUrl);
      try {
        const res = await jsonRequest(
          `${ctx.baseUrl}/lnurl/session/${session.sessionId}/invoice`,
          "POST",
          {},
          session.token,
        );
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/missing pr/i);
      } finally {
        session.abort();
      }
    });

    it("should return 404 when no invoice is pending", async () => {
      const session = await openSession(ctx.baseUrl);
      try {
        const res = await jsonRequest(
          `${ctx.baseUrl}/lnurl/session/${session.sessionId}/invoice`,
          "POST",
          { pr: "lnbc1whatever" },
          session.token,
        );
        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/no pending/i);
      } finally {
        session.abort();
      }
    });

    it("should reject pending invoice request when wallet sends error", async () => {
      const session = await openSession(ctx.baseUrl);
      try {
        const eventPromise = nextSseEvent(session.response);
        const payerPromise = jsonRequest(
          `${ctx.baseUrl}/lnurl/${session.sessionId}/callback?amount=50000`,
        );

        await eventPromise;

        // Wallet rejects by sending error instead of pr
        const rejectRes = await jsonRequest(
          `${ctx.baseUrl}/lnurl/session/${session.sessionId}/invoice`,
          "POST",
          { error: "Amount outside Lightning receive limits" },
          session.token,
        );
        expect(rejectRes.status).toBe(200);
        expect(rejectRes.body.ok).toBe(true);

        // Payer should get an error
        const payerRes = await payerPromise;
        expect(payerRes.body.status).toBe("ERROR");
        expect(payerRes.body.reason).toMatch(/outside/i);
      } finally {
        session.abort();
      }
    });
  });

  describe("Session lifecycle", () => {
    it("should deactivate LNURL when SSE stream closes", async () => {
      const session = await openSession(ctx.baseUrl);

      // Verify session is active
      const activeMeta = await jsonRequest(
        `${ctx.baseUrl}/lnurl/${session.sessionId}`,
      );
      expect(activeMeta.body.tag).toBe("payRequest");

      // Close the SSE stream
      session.abort();
      await new Promise((r) => setTimeout(r, 100));

      // Session should now be inactive
      const inactiveMeta = await jsonRequest(
        `${ctx.baseUrl}/lnurl/${session.sessionId}`,
      );
      expect(inactiveMeta.body.status).toBe("ERROR");
    });

    it("should reject pending invoice request when session closes", async () => {
      const session = await openSession(ctx.baseUrl);

      // Start an invoice request
      const invoicePromise = jsonRequest(
        `${ctx.baseUrl}/lnurl/${session.sessionId}/callback?amount=50000`,
      );

      await new Promise((r) => setTimeout(r, 100));

      // Close the SSE stream while invoice request is pending
      session.abort();

      const res = await invoicePromise;
      expect(res.body.status).toBe("ERROR");
      expect(res.body.reason).toMatch(/session closed/i);
    });
  });

  describe("Multiple sessions", () => {
    it("should support multiple concurrent sessions independently", async () => {
      const session1 = await openSession(ctx.baseUrl);
      const session2 = await openSession(ctx.baseUrl);

      try {
        expect(session1.sessionId).not.toBe(session2.sessionId);

        // Both sessions should return valid metadata
        const [meta1, meta2] = await Promise.all([
          jsonRequest(`${ctx.baseUrl}/lnurl/${session1.sessionId}`),
          jsonRequest(`${ctx.baseUrl}/lnurl/${session2.sessionId}`),
        ]);
        expect(meta1.body.tag).toBe("payRequest");
        expect(meta2.body.tag).toBe("payRequest");

        // Closing one should not affect the other
        session1.abort();
        await new Promise((r) => setTimeout(r, 100));

        const meta1After = await jsonRequest(
          `${ctx.baseUrl}/lnurl/${session1.sessionId}`,
        );
        const meta2After = await jsonRequest(
          `${ctx.baseUrl}/lnurl/${session2.sessionId}`,
        );
        expect(meta1After.body.status).toBe("ERROR");
        expect(meta2After.body.tag).toBe("payRequest");
      } finally {
        session1.abort();
        session2.abort();
      }
    });
  });

  describe("LNURL encoding", () => {
    it("should produce a valid bech32-encoded LNURL", async () => {
      const session = await openSession(ctx.baseUrl);
      try {
        // LNURL should be uppercase bech32 starting with LNURL1
        expect(session.lnurl).toMatch(/^LNURL1[A-Z0-9]+$/);

        // Decode and verify it points to our metadata endpoint
        const { bech32: bech32Codec } = await import("@scure/base");
        const decoded = bech32Codec.decode(session.lnurl.toLowerCase() as `lnurl1${string}`, 1023);
        const url = new TextDecoder().decode(
          bech32Codec.fromWords(decoded.words),
        );
        expect(url).toBe(`${ctx.baseUrl}/lnurl/${session.sessionId}`);
      } finally {
        session.abort();
      }
    });
  });

  describe("Metadata format", () => {
    it("should return valid LUD-06 metadata JSON string", async () => {
      const session = await openSession(ctx.baseUrl);
      try {
        const res = await jsonRequest(
          `${ctx.baseUrl}/lnurl/${session.sessionId}`,
        );
        const metadata = JSON.parse(res.body.metadata as string);
        expect(Array.isArray(metadata)).toBe(true);
        expect(metadata[0][0]).toBe("text/plain");
        expect(typeof metadata[0][1]).toBe("string");
      } finally {
        session.abort();
      }
    });
  });

  describe("Callback edge cases", () => {
    it("should return error for non-numeric amount", async () => {
      const session = await openSession(ctx.baseUrl);
      try {
        const res = await jsonRequest(
          `${ctx.baseUrl}/lnurl/${session.sessionId}/callback?amount=abc`,
        );
        expect(res.body.status).toBe("ERROR");
        expect(res.body.reason).toMatch(/missing|invalid/i);
      } finally {
        session.abort();
      }
    });

    it("should return error for negative amount", async () => {
      const session = await openSession(ctx.baseUrl);
      try {
        const res = await jsonRequest(
          `${ctx.baseUrl}/lnurl/${session.sessionId}/callback?amount=-1000`,
        );
        expect(res.body.status).toBe("ERROR");
        expect(res.body.reason).toMatch(/between/i);
      } finally {
        session.abort();
      }
    });

    it("should return error for zero amount", async () => {
      const session = await openSession(ctx.baseUrl);
      try {
        const res = await jsonRequest(
          `${ctx.baseUrl}/lnurl/${session.sessionId}/callback?amount=0`,
        );
        expect(res.body.status).toBe("ERROR");
        expect(res.body.reason).toMatch(/between/i);
      } finally {
        session.abort();
      }
    });

    it("should pass comment through SSE event to wallet", async () => {
      const session = await openSession(ctx.baseUrl);
      try {
        const eventPromise = nextSseEvent(session.response);
        const payerPromise = jsonRequest(
          `${ctx.baseUrl}/lnurl/${session.sessionId}/callback?amount=50000&comment=hello%20world`,
        );

        const event = await eventPromise;
        expect(event.data.comment).toBe("hello world");

        // Resolve so payer doesn't hang
        await jsonRequest(
          `${ctx.baseUrl}/lnurl/session/${session.sessionId}/invoice`,
          "POST",
          { pr: "lnbc1test" },
          session.token,
        );
        await payerPromise;
      } finally {
        session.abort();
      }
    });

    it("should handle callback without comment", async () => {
      const session = await openSession(ctx.baseUrl);
      try {
        const eventPromise = nextSseEvent(session.response);
        const payerPromise = jsonRequest(
          `${ctx.baseUrl}/lnurl/${session.sessionId}/callback?amount=50000`,
        );

        const event = await eventPromise;
        expect(event.data.amountMsat).toBe(50000);
        // comment should be undefined/absent
        expect(event.data.comment).toBeUndefined();

        await jsonRequest(
          `${ctx.baseUrl}/lnurl/session/${session.sessionId}/invoice`,
          "POST",
          { pr: "lnbc1test" },
          session.token,
        );
        await payerPromise;
      } finally {
        session.abort();
      }
    });

    it("should accept amount at exact minimum boundary", async () => {
      const session = await openSession(ctx.baseUrl);
      try {
        const eventPromise = nextSseEvent(session.response);
        const payerPromise = jsonRequest(
          `${ctx.baseUrl}/lnurl/${session.sessionId}/callback?amount=${CONFIG.minSendable}`,
        );

        const event = await eventPromise;
        expect(event.data.amountMsat).toBe(CONFIG.minSendable);

        await jsonRequest(
          `${ctx.baseUrl}/lnurl/session/${session.sessionId}/invoice`,
          "POST",
          { pr: "lnbc1min" },
          session.token,
        );
        const res = await payerPromise;
        expect(res.body.pr).toBe("lnbc1min");
      } finally {
        session.abort();
      }
    });

    it("should accept amount at exact maximum boundary", async () => {
      const session = await openSession(ctx.baseUrl);
      try {
        const eventPromise = nextSseEvent(session.response);
        const payerPromise = jsonRequest(
          `${ctx.baseUrl}/lnurl/${session.sessionId}/callback?amount=${CONFIG.maxSendable}`,
        );

        const event = await eventPromise;
        expect(event.data.amountMsat).toBe(CONFIG.maxSendable);

        await jsonRequest(
          `${ctx.baseUrl}/lnurl/session/${session.sessionId}/invoice`,
          "POST",
          { pr: "lnbc1max" },
          session.token,
        );
        const res = await payerPromise;
        expect(res.body.pr).toBe("lnbc1max");
      } finally {
        session.abort();
      }
    });
  });

  describe("Reusable sessions (client-provided credentials)", () => {
    const creds = {
      sessionId: "a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8",
      token: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    };

    it("should use client-provided sessionId and token", async () => {
      const session = await openSession(ctx.baseUrl, creds);
      try {
        expect(session.sessionId).toBe(creds.sessionId);
        expect(session.token).toBe(creds.token);
      } finally {
        session.abort();
      }
    });

    it("should produce the same LNURL for the same sessionId", async () => {
      const session1 = await openSession(ctx.baseUrl, creds);
      const lnurl1 = session1.lnurl;
      session1.abort();
      await new Promise((r) => setTimeout(r, 100));

      const session2 = await openSession(ctx.baseUrl, creds);
      try {
        expect(session2.lnurl).toBe(lnurl1);
      } finally {
        session2.abort();
      }
    });

    it("should allow reconnecting while old SSE is still open", async () => {
      const session1 = await openSession(ctx.baseUrl, creds);
      const lnurl1 = session1.lnurl;

      // Reconnect with same ID — old connection should be replaced
      const session2 = await openSession(ctx.baseUrl, creds);
      try {
        expect(session2.lnurl).toBe(lnurl1);

        // New session should be active
        const meta = await jsonRequest(
          `${ctx.baseUrl}/lnurl/${creds.sessionId}`,
        );
        expect(meta.body.tag).toBe("payRequest");
      } finally {
        session1.abort();
        session2.abort();
      }
    });

    it("should authenticate with client-provided token", async () => {
      const session = await openSession(ctx.baseUrl, creds);
      try {
        const eventPromise = nextSseEvent(session.response);
        const payerPromise = jsonRequest(
          `${ctx.baseUrl}/lnurl/${creds.sessionId}/callback?amount=50000`,
        );

        await eventPromise;

        // Post invoice with the client-provided token
        const invoiceRes = await jsonRequest(
          `${ctx.baseUrl}/lnurl/session/${creds.sessionId}/invoice`,
          "POST",
          { pr: "lnbc1reusable" },
          creds.token,
        );
        expect(invoiceRes.status).toBe(200);

        const payerRes = await payerPromise;
        expect(payerRes.body.pr).toBe("lnbc1reusable");
      } finally {
        session.abort();
      }
    });

    it("should reject sessionId shorter than 16 characters", async () => {
      const res = await jsonRequest(
        `${ctx.baseUrl}/lnurl/session`,
        "POST",
        { sessionId: "tooshort", token: creds.token },
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/sessionId/i);
    });

    it("should reject token shorter than 32 characters", async () => {
      const res = await jsonRequest(
        `${ctx.baseUrl}/lnurl/session`,
        "POST",
        { sessionId: creds.sessionId, token: "tooshort" },
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/token/i);
    });
  });

  describe("Invoice endpoint edge cases", () => {
    it("should return 401 for unknown session id", async () => {
      const res = await jsonRequest(
        `${ctx.baseUrl}/lnurl/session/nonexistent/invoice`,
        "POST",
        { pr: "lnbc1test" },
        "some-token",
      );
      expect(res.status).toBe(401);
    });

    it("should return 400 when pr is empty string", async () => {
      const session = await openSession(ctx.baseUrl);
      try {
        const res = await jsonRequest(
          `${ctx.baseUrl}/lnurl/session/${session.sessionId}/invoice`,
          "POST",
          { pr: "" },
          session.token,
        );
        expect(res.status).toBe(400);
      } finally {
        session.abort();
      }
    });

    it("should allow a second invoice flow after the first completes", async () => {
      const session = await openSession(ctx.baseUrl);
      try {
        // First flow
        const event1Promise = nextSseEvent(session.response);
        const payer1Promise = jsonRequest(
          `${ctx.baseUrl}/lnurl/${session.sessionId}/callback?amount=10000`,
        );
        await event1Promise;
        await jsonRequest(
          `${ctx.baseUrl}/lnurl/session/${session.sessionId}/invoice`,
          "POST",
          { pr: "lnbc1first" },
          session.token,
        );
        const payer1Res = await payer1Promise;
        expect(payer1Res.body.pr).toBe("lnbc1first");

        // Second flow on same session
        const event2Promise = nextSseEvent(session.response);
        const payer2Promise = jsonRequest(
          `${ctx.baseUrl}/lnurl/${session.sessionId}/callback?amount=20000`,
        );
        await event2Promise;
        await jsonRequest(
          `${ctx.baseUrl}/lnurl/session/${session.sessionId}/invoice`,
          "POST",
          { pr: "lnbc1second" },
          session.token,
        );
        const payer2Res = await payer2Promise;
        expect(payer2Res.body.pr).toBe("lnbc1second");
      } finally {
        session.abort();
      }
    });
  });
});
