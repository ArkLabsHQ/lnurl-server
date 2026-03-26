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
 */
async function openSession(baseUrl: string): Promise<{
  sessionId: string;
  lnurl: string;
  response: http.IncomingMessage;
  abort: () => void;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}/lnurl/session`, { method: "POST" });

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
            if (data.sessionId && data.lnurl) {
              // Stop listening for initial event, keep stream open
              res.removeListener("data", onData);
              resolve({
                sessionId: data.sessionId,
                lnurl: data.lnurl,
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
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      method,
      headers: { "Content-Type": "application/json" },
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

        // Wallet creates swap and posts bolt11 back
        const invoiceRes = await jsonRequest(
          `${ctx.baseUrl}/lnurl/session/${session.sessionId}/invoice`,
          "POST",
          { pr: fakeBolt11 },
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
    it("should return 400 when pr is missing", async () => {
      const session = await openSession(ctx.baseUrl);
      try {
        const res = await jsonRequest(
          `${ctx.baseUrl}/lnurl/session/${session.sessionId}/invoice`,
          "POST",
          {},
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
        );
        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/no pending/i);
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
});
