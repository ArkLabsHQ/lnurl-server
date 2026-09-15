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