import { LnurlError, LnurlTransportError } from "./errors.js";
import { apiFetch, type FetchImpl } from "./http.js";
import { readSseStream, type SseFrame } from "./sse.js";

export interface OpenSessionOptions {
  token?: string;
  signal?: AbortSignal;
  reconnect?: false | { maxAttempts?: number; baseDelayMs?: number };
}

export interface InvoiceResponder {
  answerInvoice(pr: string): Promise<void>;
  rejectInvoice(reason: string): Promise<void>;
}

export interface SessionHandlers {
  onInvoiceRequest(req: { amountMsat: number; comment?: string }, respond: InvoiceResponder): void | Promise<void>;
  onSettled?(data: Record<string, unknown>): void;
  onError?(err: Error): void;
  onReconnect?(attempt: number): void;
}

export interface LnurlSession {
  readonly sessionId: string;
  readonly lnurl: string;
  readonly token: string;
  readonly closed: boolean;
  reportSettled(preimage: string): Promise<void>;
  close(): void;
}

interface SessionCreated {
  sessionId: string;
  lnurl: string;
  token: string;
}

function postJson(url: string, token: string, body: unknown, fetchImpl: FetchImpl): Promise<void> {
  return apiFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }, fetchImpl).then(() => undefined);
}

export async function openSession(
  baseUrl: string,
  opts: OpenSessionOptions,
  handlers: SessionHandlers,
  fetchImpl: FetchImpl,
): Promise<LnurlSession> {
  const root = baseUrl.replace(/\/+$/, "");
  const token = opts.token;
  const reconnect = opts.reconnect;
  const maxAttempts = reconnect === false ? 0 : (reconnect?.maxAttempts ?? 5);
  const baseDelayMs = (typeof reconnect === "object" ? reconnect.baseDelayMs : undefined) ?? 500;
  const resumable = token !== undefined && reconnect !== false;
  const signal = opts.signal;

  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeBody: ReadableStream<Uint8Array> | null = null;
  let info: SessionCreated | null = null;

  let resolveOpened!: (s: LnurlSession) => void;
  let rejectOpened!: (err: unknown) => void;
  const opened = new Promise<LnurlSession>((res, rej) => {
    resolveOpened = res;
    rejectOpened = rej;
  });

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    // readSseStream only notices an abort between reads, so cancel the body
    // itself to release a read parked on a quiet stream.
    const body = activeBody;
    activeBody = null;
    if (body) void body.cancel().catch(() => undefined);
  };

  const makeSession = (created: SessionCreated): LnurlSession => ({
    sessionId: created.sessionId,
    lnurl: created.lnurl,
    token: created.token,
    get closed() {
      return closed;
    },
    reportSettled: (preimage: string): Promise<void> =>
      postJson(`${root}/lnurl/session/${created.sessionId}/settled`, created.token, { preimage }, fetchImpl),
    close,
  });

  const postSession = async (): Promise<Response> => {
    let response: Response;
    try {
      response = await fetchImpl(`${root}/lnurl/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(token !== undefined ? { token } : {}),
        signal,
      });
    } catch (err) {
      if (err instanceof LnurlError) throw err;
      throw new LnurlTransportError("Session request failed", { cause: err });
    }
    if (!response.ok) {
      let reason = response.statusText;
      let code: string | undefined;
      try {
        const data = (await response.json()) as Record<string, unknown>;
        if (typeof data.error === "string") reason = data.error;
        else if (typeof data.reason === "string") reason = data.reason;
        if (typeof data.code === "string") code = data.code;
      } catch {
        // keep statusText when the error body is not JSON
      }
      throw new LnurlError(reason, { httpStatus: response.status, code });
    }
    if (response.body === null) throw new LnurlTransportError("Session stream has no readable body");
    return response;
  };

  const onFrame = (frame: SseFrame): void => {
    if (frame.event === "session_created") {
      if (info) return;
      let created: SessionCreated;
      try {
        created = JSON.parse(frame.data) as SessionCreated;
      } catch (err) {
        rejectOpened(new LnurlTransportError("Invalid session_created frame", { cause: err }));
        return;
      }
      info = created;
      resolveOpened(makeSession(created));
      return;
    }
    const current = info;
    if (!current) return;
    if (frame.event === "invoice_request") {
      let req: { amountMsat: number; comment?: string };
      try {
        req = JSON.parse(frame.data) as { amountMsat: number; comment?: string };
      } catch (err) {
        handlers.onError?.(new LnurlTransportError("Invalid invoice_request frame", { cause: err }));
        return;
      }
      const respond: InvoiceResponder = {
        answerInvoice: (pr: string): Promise<void> =>
          postJson(`${root}/lnurl/session/${current.sessionId}/invoice`, current.token, { pr }, fetchImpl),
        rejectInvoice: (reason: string): Promise<void> =>
          postJson(`${root}/lnurl/session/${current.sessionId}/invoice`, current.token, { error: reason }, fetchImpl),
      };
      try {
        const result = handlers.onInvoiceRequest(
          req.comment === undefined ? { amountMsat: req.amountMsat } : { amountMsat: req.amountMsat, comment: req.comment },
          respond,
        );
        if (result instanceof Promise) result.catch((err: unknown) => handlers.onError?.(err as Error));
      } catch (err) {
        handlers.onError?.(err as Error);
      }
      return;
    }
    if (frame.event === "invoice_settled") {
      try {
        handlers.onSettled?.(JSON.parse(frame.data) as Record<string, unknown>);
      } catch (err) {
        handlers.onError?.(new LnurlTransportError("Invalid invoice_settled frame", { cause: err }));
      }
      return;
    }
    if (frame.event === "error") {
      let message = frame.data;
      try {
        const data = JSON.parse(frame.data) as Record<string, unknown>;
        if (typeof data.error === "string") message = data.error;
      } catch {
        // fall back to the raw frame data
      }
      handlers.onError?.(new Error(message));
    }
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      timer = setTimeout(() => {
        timer = undefined;
        resolve();
      }, ms);
    });

  const run = async (): Promise<void> => {
    let attempts = 0;
    for (;;) {
      let response: Response;
      try {
        response = await postSession();
      } catch (err) {
        if (!info) {
          rejectOpened(err);
          return;
        }
        // A 409 means the derived id is held by a different token; retrying cannot help.
        if (err instanceof LnurlError && err.httpStatus === 409) {
          handlers.onError?.(err);
          return;
        }
        if (closed || signal?.aborted || !resumable || attempts >= maxAttempts) {
          handlers.onError?.(err as Error);
          return;
        }
        attempts += 1;
        handlers.onReconnect?.(attempts);
        await sleep(baseDelayMs * 2 ** (attempts - 1));
        continue;
      }
      const body = response.body as ReadableStream<Uint8Array>;
      activeBody = body;
      try {
        await readSseStream(body, onFrame, signal);
      } catch (err) {
        if (closed || signal?.aborted) return;
        if (!info) {
          rejectOpened(err);
          return;
        }
        handlers.onError?.(err as Error);
      } finally {
        if (activeBody === body) activeBody = null;
      }
      if (!info) {
        rejectOpened(new LnurlTransportError("Session stream ended before session_created"));
        return;
      }
      if (closed || signal?.aborted || !resumable || attempts >= maxAttempts) return;
      attempts += 1;
      handlers.onReconnect?.(attempts);
      await sleep(baseDelayMs * 2 ** (attempts - 1));
    }
  };

  void run();
  return opened;
}