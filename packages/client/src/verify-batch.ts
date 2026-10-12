import { LnurlError, LnurlTransportError } from "./errors.js";
import { lnurlFetch, type FetchImpl } from "./http.js";
import { parseVerifyStatus } from "./payer.js";
import { readSseStream } from "./sse.js";
import type { VerifyStatus } from "./types.js";

/** One entry of the batch endpoint's `results` map, keyed by the verify URL. */
export type VerifyBatchResultItem =
  | { kind: "verify"; status: VerifyStatus }
  | { kind: "error"; reason: string };

export interface VerifyBatchResult {
  /** One entry per presented verify URL, keyed by the exact string the caller presented. */
  results: Record<string, VerifyBatchResultItem>;
}

export interface BatchVerifyOptions {
  /** Abort the whole call. */
  signal?: AbortSignal;
}

/** URL strings are opaque; duplicates collapse to one entry on both paths. */
function dedupeUrls(urls: readonly string[]): string[] {
  return [...new Set(urls)];
}

/**
 * One-shot LUD-XX verifyBatch snapshot: N invoice statuses on one GET.
 *
 * `verifyBatchUrl` is the endpoint advertised alongside the verify URLs in the
 * callback response; callers group pending invoices by that URL and issue one
 * request per group. The `verify` URLs themselves are opaque and passed whole.
 * A per-item error (`{status:"ERROR", reason}` inside `results`) is data, not a
 * transport failure, so it is represented rather than thrown; a malformed
 * request carries the top-level error shape and still throws.
 */
export async function batchVerify(
  verifyBatchUrl: string,
  verifyUrls: readonly string[],
  opts?: BatchVerifyOptions,
  fetchImpl?: FetchImpl,
): Promise<VerifyBatchResult> {
  if (!verifyBatchUrl) throw new LnurlError("verifyBatch URL is required");
  const add = dedupeUrls(verifyUrls);
  if (add.length === 0) throw new LnurlError("at least one verify URL is required");

  const f: FetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  return fetchBatch(verifyBatchUrl, add, opts?.signal, f);
}

// LUD-XX: 414/431 means the set did not fit one request. Halves go one after
// the other so a split does not trip the endpoint's per-caller rate limit.
const TOO_LARGE = new Set([414, 431]);

async function fetchBatch(verifyBatchUrl: string, urls: string[], signal: AbortSignal | undefined, f: FetchImpl): Promise<VerifyBatchResult> {
  try {
    const body = await lnurlFetch<Record<string, unknown>>(withVerifyParams(verifyBatchUrl, urls), { signal }, f);
    return parseBatchResults(body, urls);
  } catch (err) {
    if (urls.length < 2 || !(err instanceof LnurlError) || !TOO_LARGE.has(err.httpStatus ?? 0)) throw err;
    const mid = Math.ceil(urls.length / 2);
    const head = await fetchBatch(verifyBatchUrl, urls.slice(0, mid), signal, f);
    const tail = await fetchBatch(verifyBatchUrl, urls.slice(mid), signal, f);
    return { results: Object.assign(Object.create(null), head.results, tail.results) };
  }
}

function withVerifyParams(verifyBatchUrl: string, verifyUrls: readonly string[]): string {
  const params = new URLSearchParams();
  for (const url of verifyUrls) params.append("verify", url);
  return `${verifyBatchUrl}${verifyBatchUrl.includes("?") ? "&" : "?"}${params.toString()}`;
}

function parseBatchResults(body: Record<string, unknown>, requested: readonly string[]): VerifyBatchResult {
  const raw =
    typeof body.results === "object" && body.results !== null ? (body.results as Record<string, unknown>) : undefined;
  if (!raw) throw new LnurlTransportError("Batch verify response carries no results map");
  // Null prototype: verify URLs are caller data, and "__proto__" must stay a key.
  const results: Record<string, VerifyBatchResultItem> = Object.create(null);
  for (const url of requested) {
    const entry = Object.hasOwn(raw, url) ? raw[url] : undefined;
    if (typeof entry !== "object" || entry === null) {
      // The endpoint promises an entry per presented URL; absence is still data,
      // so it lands as its own item instead of breaking the caller's loop.
      results[url] = { kind: "error", reason: "no answer for this verify url" };
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (record.status !== "OK") {
      results[url] = { kind: "error", reason: typeof record.reason === "string" ? record.reason : "unknown error" };
      continue;
    }
    // One bad entry is that entry's answer, not the whole batch's.
    try {
      results[url] = { kind: "verify", status: parseVerifyStatus(record) };
    } catch (err) {
      results[url] = { kind: "error", reason: (err as Error).message };
    }
  }
  return { results };
}

export interface OpenVerifyBatchStreamOptions {
  /** The endpoint from the callback response's `verifyBatch` field. */
  verifyBatchUrl: string;
  /** Verify URLs pending at open; the endpoint covers exactly this set at first. */
  verifyUrls: readonly string[];
  /** Abort from the caller's side, triggering a clean close. */
  signal?: AbortSignal;
}

export interface VerifyBatchStreamHandlers {
  /** Every verify-answer frame: the initial snapshot burst and later settlements. */
  onUpdate?: (url: string, status: VerifyStatus) => void;
  /** One call per removed URL; nothing further arrives for it. */
  onRemoved?: (url: string) => void;
  /** A stream failure other than a close the user initiated. */
  onError?: (err: Error) => void;
  /** Stream ended, cleanly or in failure. */
  onClose?: () => void;
}

export interface VerifyBatchStream {
  /** The server's session for this stream; undefined until the session frame lands. */
  readonly sessionId: string | undefined;
  /**
   * Adds and removes tracked verify URLs while the connection stays open. Each
   * added URL is answered with one snapshot frame; each removed one with one
   * `removed` frame. Throws when the stream has already ended.
   */
  update(verifyUrlsToAdd: readonly string[], verifyUrlsToRemove?: readonly string[]): void;
  /** Ends the stream locally; safe to call more than once. */
  close(): void;
}

/**
 * Opens an LUD-XX verifyBatch stream on one connection: the endpoint reads the
 * presented set, emits the snapshot burst, then pushes settlements live.
 *
 * A service without streaming answers the same request with the one-shot JSON
 * snapshot (per LUD-01 the header is ignored, only 406 reaches a rejection):
 * that body is still the current settlement state, so it is delivered through
 * `onUpdate` before `onClose` and the caller falls back to polling.
 */
export function openVerifyBatchStream(
  opts: OpenVerifyBatchStreamOptions,
  handlers: VerifyBatchStreamHandlers,
  fetchImpl?: FetchImpl,
): VerifyBatchStream {
  if (!opts.verifyBatchUrl) throw new LnurlError("verifyBatch URL is required");
  const openUrls = dedupeUrls(opts.verifyUrls);
  if (openUrls.length === 0) throw new LnurlError("at least one verify URL is required");
  if (opts.signal?.aborted) throw opts.signal.reason ?? new LnurlError("Aborted");
  const f: FetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

  const controller = new AbortController();
  const onExternalAbort = (): void => controller.abort(opts.signal!.reason);
  opts.signal?.addEventListener("abort", onExternalAbort, { once: true });

  let sessionId: string | undefined;
  let closed = false;

  /** Clean end: user close, caller abort, or a natural stream end. */
  function finish(): void {
    if (closed) return;
    closed = true;
    controller.abort();
    opts.signal?.removeEventListener("abort", onExternalAbort);
    handlers.onClose?.();
  }

  function fail(err: unknown): void {
    if (closed) return;
    closed = true;
    controller.abort();
    opts.signal?.removeEventListener("abort", onExternalAbort);
    const error =
      err instanceof LnurlError
        ? err
        : err instanceof Error
          ? new LnurlTransportError(err.message, { cause: err })
          : new LnurlTransportError("Batch stream failed");
    handlers.onError?.(error);
    handlers.onClose?.();
  }

  async function applyUpdate(add: readonly string[], remove: readonly string[]): Promise<void> {
    const params = new URLSearchParams();
    params.set("session", sessionId!);
    for (const url of dedupeUrls(add)) params.append("add", url);
    for (const url of dedupeUrls(remove)) params.append("remove", url);
    const sep = opts.verifyBatchUrl.includes("?") ? "&" : "?";
    try {
      await lnurlFetch(`${opts.verifyBatchUrl}${sep}${params.toString()}`, undefined, f);
    } catch (err) {
      // The stream is the only consumer of these effects; a failed update ends
      // the watch rather than leaving the caller tracking something unset.
      fail(err instanceof LnurlError ? err : new LnurlTransportError("Batch update failed", { cause: err }));
    }
  }

  function handleFrame(event: string, raw: string): void {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new LnurlTransportError("Batch stream carried a frame that is not JSON");
    }
    if (typeof body !== "object" || body === null) throw new LnurlTransportError("Batch stream carried an empty frame");
    const record = body as Record<string, unknown>;
    if (event === "session") {
      if (typeof record.session === "string") sessionId = record.session;
      return;
    }
    if (event === "removed") {
      if (typeof record.verify === "string") handlers.onRemoved?.(record.verify);
      return;
    }
    // Result frames carry no named event: the verify URL is the correlation key.
    const url = typeof record.verify === "string" ? record.verify : undefined;
    if (!url) throw new LnurlTransportError("Batch stream carried a result frame without a verify url");
    handlers.onUpdate?.(url, parseVerifyStatus(record));
  }

  void (async () => {
    try {
      const openUrl = withVerifyParams(opts.verifyBatchUrl, openUrls);
      let response = await f(openUrl, { headers: { Accept: "text/event-stream" }, signal: controller.signal });
      // LUD-XX: a 406 means "no stream here", and the same request without the
      // Accept header is still the snapshot.
      if (response.status === 406) response = await f(openUrl, { signal: controller.signal });
      if (!response.ok) throw new LnurlError(response.statusText, { httpStatus: response.status });
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream")) {
        const snapshot = (await response.json()) as Record<string, unknown>;
        const parsed = parseBatchResults(snapshot, openUrls);
        for (const [url, item] of Object.entries(parsed.results)) {
          if (item.kind === "verify") handlers.onUpdate?.(url, item.status);
        }
        finish();
        return;
      }
      await readSseStream(response.body!, (frame) => {
        handleFrame(frame.event, frame.data);
      }, controller.signal);
    } catch (err) {
      if (opts.signal?.aborted) {
        // The caller aborted; that is a clean close, not a stream failure.
        finish();
        return;
      }
      fail(err);
      return;
    }
    finish();
  })();

  return {
    get sessionId() {
      return sessionId;
    },
    update(add, remove = []) {
      if (closed) throw new LnurlError("Batch stream has ended");
      if (!sessionId) throw new LnurlError("Batch stream has not yet announced its session");
      void applyUpdate(add, remove);
    },
    close() {
      finish();
    },
  };
}
