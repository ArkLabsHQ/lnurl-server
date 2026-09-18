import { describe, it, expect, vi } from "vitest";
import { openSession } from "../src/session.js";
import { LnurlTransportError } from "../src/errors.js";

const sseResponse = (frames: string[], onCancel?: () => void) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        for (const f of frames) c.enqueue(enc.encode(f));
      },
      cancel() { onCancel?.(); },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

/** Like sseResponse but the stream ends, which is what triggers a reconnect. */
const endingSseResponse = (frames: string[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        for (const f of frames) c.enqueue(enc.encode(f));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

const created = (id = "sess1") =>
  `event: session_created\ndata: ${JSON.stringify({ sessionId: id, lnurl: "LNURL1ABC", token: "tok" })}\n\n`;

describe("openSession", () => {
  it("POSTs to /lnurl/session and resolves on session_created", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return sseResponse([created()]);
    };
    const s = await openSession("https://x", { token: "aa".repeat(16) }, { onInvoiceRequest: () => {} }, fetchImpl as never);
    expect(calls[0].url).toBe("https://x/lnurl/session");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ token: "aa".repeat(16) });
    expect(s).toMatchObject({ sessionId: "sess1", lnurl: "LNURL1ABC", token: "tok" });
    s.close();
  });

  it("answers an invoice_request via POST /invoice with the bearer token", async () => {
    const posts: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/lnurl/session")) {
        return sseResponse([created(), `event: invoice_request\ndata: {"amountMsat":1000,"comment":"hi"}\n\n`]);
      }
      posts.push({ url: u, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const seen: { amountMsat: number }[] = [];
    const s = await openSession("https://x", {}, {
      onInvoiceRequest: async (req, respond) => { seen.push(req); await respond.answerInvoice("lnbc1xyz"); },
    }, fetchImpl as never);
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(seen[0]).toEqual({ amountMsat: 1000, comment: "hi" });
    expect(posts[0].url).toBe("https://x/lnurl/session/sess1/invoice");
    expect((posts[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(String(posts[0].init?.body))).toEqual({ pr: "lnbc1xyz" });
    s.close();
  });

  it("rejects an invoice request with an error body", async () => {
    const posts: RequestInit[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/lnurl/session")) {
        return sseResponse([created(), `event: invoice_request\ndata: {"amountMsat":1000}\n\n`]);
      }
      posts.push(init!);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const s = await openSession("https://x", {}, {
      onInvoiceRequest: async (_req, respond) => { await respond.rejectInvoice("no capacity"); },
    }, fetchImpl as never);
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(JSON.parse(String(posts[0].body))).toEqual({ error: "no capacity" });
    s.close();
  });

  it("reportSettled posts the preimage to the settled route", async () => {
    const posts: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/lnurl/session")) return sseResponse([created()]);
      posts.push({ url: u, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const s = await openSession("https://x", {}, { onInvoiceRequest: () => {} }, fetchImpl as never);
    await s.reportSettled("ab".repeat(32));
    expect(posts[0].url).toBe("https://x/lnurl/session/sess1/settled");
    expect(JSON.parse(String(posts[0].init?.body))).toEqual({ preimage: "ab".repeat(32) });
    s.close();
  });

  it("throws a transport error when the response has no readable body", async () => {
    const fetchImpl = async () => new Response(null, { status: 200 });
    await expect(openSession("https://x", {}, { onInvoiceRequest: () => {} }, fetchImpl as never))
      .rejects.toBeInstanceOf(LnurlTransportError);
  });

  it("surfaces a server error frame through onError", async () => {
    const errors: Error[] = [];
    const fetchImpl = async () => sseResponse([created(), `event: error\ndata: {"error":"Session closed by admin"}\n\n`]);
    const s = await openSession("https://x", {}, {
      onInvoiceRequest: () => {},
      onError: (e) => errors.push(e),
    }, fetchImpl as never);
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0].message).toContain("Session closed by admin");
    s.close();
  });

  // The budget counts CONSECUTIVE failures. A stream that delivered frames proves
  // the endpoint is healthy and resets it — otherwise a long-lived session that
  // reconnected maxAttempts times over days would refuse the next transient drop.
  it("resets the reconnect budget after a stream that delivered frames", async () => {
    let opens = 0;
    const fetchImpl = async (url: string) => {
      if (String(url).endsWith("/lnurl/session")) {
        opens++;
        return endingSseResponse([created()]);
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const s = await openSession(
      "https://x",
      { token: "aa".repeat(16), reconnect: { maxAttempts: 2, baseDelayMs: 1 } },
      { onInvoiceRequest: () => {} },
      fetchImpl as never,
    );
    // With a lifetime budget this would stop at 3 opens (initial + 2 retries).
    await vi.waitFor(() => expect(opens).toBeGreaterThan(4), { timeout: 3000 });
    s.close();
  });

  // A cast cannot catch well-formed JSON with the wrong fields. Without a guard
  // the first symptom is a POST to /session/undefined/settled — a 404 pointing
  // nowhere near the cause.
  it("rejects a session_created frame missing required fields", async () => {
    const fetchImpl = async () =>
      sseResponse([`event: session_created\ndata: ${JSON.stringify({ sessionId: "s1" })}\n\n`]);
    await expect(openSession("https://x", {}, { onInvoiceRequest: () => {} }, fetchImpl as never))
      .rejects.toThrow(/missing sessionId, lnurl or token/);
  });

  it("does not reconnect after an explicit close", async () => {
    let opens = 0;
    const fetchImpl = async (url: string) => {
      if (String(url).endsWith("/lnurl/session")) { opens++; return sseResponse([created()]); }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const s = await openSession("https://x", { token: "aa".repeat(16), reconnect: { baseDelayMs: 1 } },
      { onInvoiceRequest: () => {} }, fetchImpl as never);
    s.close();
    expect(s.closed).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(opens).toBe(1);
  });
});