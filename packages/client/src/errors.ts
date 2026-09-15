export class LnurlError extends Error {
  readonly reason: string;
  readonly httpStatus?: number;
  readonly code?: string;
  readonly retryable: boolean;
  constructor(reason: string, opts?: { httpStatus?: number; code?: string }) {
    super(reason);
    this.name = "LnurlError";
    this.reason = reason;
    this.httpStatus = opts?.httpStatus;
    this.code = opts?.code;
    this.retryable = opts?.httpStatus === 429;
  }
}

export class LnurlTransportError extends Error {
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts);
    this.name = "LnurlTransportError";
  }
}

export class LnurlTimeoutError extends Error {
  readonly lastSnapshot?: unknown;
  constructor(message: string, opts?: { lastSnapshot?: unknown }) {
    super(message);
    this.name = "LnurlTimeoutError";
    this.lastSnapshot = opts?.lastSnapshot;
  }
}