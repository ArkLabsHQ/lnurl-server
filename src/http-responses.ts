import type { ErrorRequestHandler } from "express";
import type { LnurlErrorResponse } from "./types/index.js";
import type { Logger } from "./logger.js";

/** An LNURL protocol failure. LUD-06 carries it in the body, so the status stays 200 unless rate-limiting. */
export class LnurlError extends Error {
  constructor(reason: string, readonly status = 200) {
    super(reason);
    this.name = "LnurlError";
  }
}

export const lnurlErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (!(err instanceof LnurlError) || res.headersSent) return next(err);
  res.status(err.status).json({ status: "ERROR", reason: err.message } satisfies LnurlErrorResponse);
};

export interface HttpErrorExtra {
  code?: string;
  details?: unknown;
}

/** A REST failure whose message is written for the client. Answered as `{ error, code?, details? }`. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra: HttpErrorExtra = {}) {
    super(message);
    this.name = new.target.name;
  }
}

export class BadRequest extends HttpError {
  constructor(message: string, extra?: HttpErrorExtra) { super(400, message, extra); }
}
export class Unauthorized extends HttpError {
  constructor(message = "Unauthorized", extra?: HttpErrorExtra) { super(401, message, extra); }
}
export class NotFound extends HttpError {
  constructor(message = "Not found", extra?: HttpErrorExtra) { super(404, message, extra); }
}
export class Conflict extends HttpError {
  constructor(message: string, extra?: HttpErrorExtra) { super(409, message, extra); }
}
export class TooManyRequests extends HttpError {
  constructor(message = "Too many requests", extra?: HttpErrorExtra) { super(429, message, extra); }
}
export class NotImplemented extends HttpError {
  constructor(message: string, extra?: HttpErrorExtra) { super(501, message, extra); }
}
export class ServiceUnavailable extends HttpError {
  constructor(message: string, extra?: HttpErrorExtra) { super(503, message, extra); }
}

/** Last in the chain. Anything not an HttpError is logged and answered without its message or stack. */
export function httpErrorHandler(logger: Logger): ErrorRequestHandler {
  return (err, _req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, ...err.extra });
      return;
    }
    // body-parser's errors (malformed JSON, 413) carry a client status and say whether the message is safe.
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      res.status(status).json({ error: (err as { expose?: boolean }).expose ? (err as Error).message : "Bad request" });
      return;
    }
    logger.error("unhandled_request_error", { requestId: res.getHeader("x-request-id"), error: err });
    res.status(500).json({ error: "Internal server error" });
  };
}
