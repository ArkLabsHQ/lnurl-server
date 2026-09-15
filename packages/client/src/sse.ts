/**
 * The SSE event names the session stream can carry: the opening frame that
 * resolves `openSession`, invoice requests from payers, settlement notices,
 * and server-side errors.
 */
export type SessionEventType = "session_created" | "invoice_request" | "invoice_settled" | "error";

/**
 * One parsed SSE frame: the `event` name and the joined `data` payload.
 * Multi-line data is joined with `\n`; comment and heartbeat lines carry no
 * data and never produce a frame.
 */
export interface SseFrame {
  /** Event name from the `event:` field; empty when the sender set none. */
  event: string;
  /** Joined payload from the `data:` lines. */
  data: string;
}

function parseFrame(raw: string): SseFrame | undefined {
  let event = "";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).startsWith(" ") ? line.slice(colon + 2) : line.slice(colon + 1);
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (dataLines.length === 0) return undefined;
  return { event, data: dataLines.join("\n") };
}

/**
 * Creates an incremental SSE parser that buffers partial chunks.
 *
 * Frames are split on blank lines with CRLF normalised, so a frame spread
 * across TCP chunks reassembles before it is emitted, and a trailing partial
 * frame waits for the rest instead of parsing half a payload.
 *
 * @returns A parser whose `push` converts each chunk into complete frames.
 */
export function createSseParser(): { push(chunk: string): SseFrame[] } {
  let buffer = "";
  return {
    push(chunk: string): SseFrame[] {
      buffer += chunk.replace(/\r\n/g, "\n");
      const frames: SseFrame[] = [];
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = parseFrame(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
        if (frame !== undefined) frames.push(frame);
      }
      return frames;
    },
  };
}

/**
 * Reads SSE frames from a fetch response body until the stream ends or the
 * signal aborts.
 *
 * Decoding uses `stream: true` so a multi-byte character split across chunks
 * still decodes; the reader lock is always released. Note the abort is only
 * noticed between reads, which is why `LnurlSession.close` also cancels the
 * body itself to release a read parked on a quiet stream.
 *
 * @param body - The response body stream carrying `text/event-stream` bytes.
 * @param onFrame - Called with each complete parsed frame.
 * @param signal - Optional abort signal stopping the read loop.
 * @returns A promise settling when the stream ends or aborts.
 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onFrame: (f: SseFrame) => void,
  signal?: AbortSignal,
): Promise<void> {
  const parser = createSseParser();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      // stream: true keeps a multi-byte char split across chunks decodable.
      if (value) for (const f of parser.push(decoder.decode(value, { stream: !done }))) onFrame(f);
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}
