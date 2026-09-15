export type SessionEventType = "session_created" | "invoice_request" | "invoice_settled" | "error";

export interface SseFrame {
  event: string;
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