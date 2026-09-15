/**
 * The single error type for expected LNURL failures.
 *
 * It unifies the server's two wire shapes: the LUD-06 protocol shape
 * (`HTTP 200` carrying `{ status: "ERROR", reason }`) and the management
 * shape (a real status code carrying `{ error, code? }`). Either way the
 * caller keeps a `reason`, plus the `httpStatus` and `code` when the wire
 * carried them.
 *
 * `retryable` is true if and only if `httpStatus === 429`: rate limiting is
 * the one failure worth retrying, everything else is terminal.
 */
export class LnurlError extends Error {
  /** Human-readable failure reason, taken from the wire `reason`/`error` field. */
  readonly reason: string;
  /** HTTP status when the failure came with one; absent for LUD-06 bodies answered at HTTP 200. */
  readonly httpStatus?: number;
  /** Machine-readable server code, when the management surface sent one. */
  readonly code?: string;
  /** True if and only if `httpStatus === 429`; every other failure is terminal. */
  readonly retryable: boolean;
  /**
   * Creates an `LnurlError`.
   *
   * @param reason - Human-readable failure reason, also used as the message.
   * @param opts - Optional `httpStatus` and `code` captured from the response.
   */
  constructor(reason: string, opts?: { httpStatus?: number; code?: string }) {
    super(reason);
    this.name = "LnurlError";
    this.reason = reason;
    this.httpStatus = opts?.httpStatus;
    this.code = opts?.code;
    this.retryable = opts?.httpStatus === 429;
  }
}

/**
 * Thrown when the request itself never completed: the injected `fetch`
 * rejected, or the body could not be read as JSON. The original failure is
 * preserved as `cause`. Protocol and rate-limit failures never surface here;
 * they become `LnurlError`.
 */
export class LnurlTransportError extends Error {
  /**
   * Creates an `LnurlTransportError`.
   *
   * @param message - Short description of which transport step failed.
   * @param opts - Optional `cause` carrying the original thrown value.
   */
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts);
    this.name = "LnurlTransportError";
  }
}

/**
 * Thrown when `pollVerify` outlasts its deadline without seeing a settled
 * invoice. `lastSnapshot` carries the most recent verify state so the caller
 * can resume, display, or log it instead of starting blind.
 */
export class LnurlTimeoutError extends Error {
  /** The most recent verify snapshot seen before the deadline, when one was seen. */
  readonly lastSnapshot?: unknown;
  /**
   * Creates an `LnurlTimeoutError`.
   *
   * @param message - Short description including the timeout that elapsed.
   * @param opts - Optional `lastSnapshot` with the latest verify state.
   */
  constructor(message: string, opts?: { lastSnapshot?: unknown }) {
    super(message);
    this.name = "LnurlTimeoutError";
    this.lastSnapshot = opts?.lastSnapshot;
  }
}
