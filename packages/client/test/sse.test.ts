import { describe, it, expect } from "vitest";
import { createSseParser, readSseStream } from "../src/sse.js";
import { LnurlTransportError } from "../src/errors.js";

describe("createSseParser", () => {
  it("refuses a frame that never ends instead of buffering it", () => {
    const p = createSseParser();
    p.push("data: ");
    expect(() => { for (let i = 0; i < 2048; i++) p.push("x".repeat(1024)); }).toThrow(LnurlTransportError);
  });

  it("cancels the body when a frame outgrows the limit", async () => {
    let sent = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent++ >= 64) return c.close();
        c.enqueue(new TextEncoder().encode("x".repeat(64 * 1024)));
      },
      cancel() { cancelled = true; },
    });
    await expect(readSseStream(body, () => {})).rejects.toBeInstanceOf(LnurlTransportError);
    expect(cancelled).toBe(true);
  });

  it("parses a complete frame", () => {
    const p = createSseParser();
    expect(p.push('event: session_created\ndata: {"sessionId":"abc"}\n\n')).toEqual([
      { event: "session_created", data: '{"sessionId":"abc"}' },
    ]);
  });

  it("reassembles a frame split across chunks", () => {
    const p = createSseParser();
    expect(p.push("event: invoice_re")).toEqual([]);
    expect(p.push('quest\ndata: {"amountMsat":1')).toEqual([]);
    expect(p.push('000}\n\n')).toEqual([{ event: "invoice_request", data: '{"amountMsat":1000}' }]);
  });

  it("returns several frames from one chunk", () => {
    const p = createSseParser();
    const frames = p.push('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n');
    expect(frames).toEqual([{ event: "a", data: "1" }, { event: "b", data: "2" }]);
  });

  it("ignores comment keepalive lines", () => {
    const p = createSseParser();
    expect(p.push(": keepalive\n\nevent: error\ndata: {}\n\n")).toEqual([{ event: "error", data: "{}" }]);
  });

  it("handles CRLF line endings", () => {
    const p = createSseParser();
    expect(p.push("event: error\r\ndata: {}\r\n\r\n")).toEqual([{ event: "error", data: "{}" }]);
  });

  // WHATWG SSE §9.2 allows a bare \r too. This server emits \n, but a proxy that
  // rewrote line endings would otherwise make every frame vanish silently.
  it("handles bare CR line endings", () => {
    const p = createSseParser();
    expect(p.push("event: error\rdata: {}\r\r")).toEqual([{ event: "error", data: "{}" }]);
  });
});

describe("readSseStream", () => {
  it("drains a stream to frames", async () => {
    const chunks = ['event: session_created\ndata: {"a":1}\n\n', 'event: error\ndata: {"b":2}\n\n'];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        for (const s of chunks) c.enqueue(enc.encode(s));
        c.close();
      },
    });
    const seen: string[] = [];
    await readSseStream(body, (f) => seen.push(f.event));
    expect(seen).toEqual(["session_created", "error"]);
  });
});