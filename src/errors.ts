/** Errors the domain throws for a caller to recognise. None of them knows HTTP:
 *  http-responses.ts maps each kind to a status, exhaustively. */

export const ERROR_KINDS = [
  "invalid_session_token",
  "provisioning",
  "invalid_rail_policy",
  "invalid_setting",
  "invalid_quote",
  "rail_refused",
  "invoice_request_failed",
  "solver_quote_failed",
  "upstream_failed",
  "malformed_record",
  "invalid_config",
] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

export abstract class AppError extends Error {
  abstract readonly kind: ErrorKind;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class InvalidSessionTokenError extends AppError {
  readonly kind = "invalid_session_token";
  constructor() { super("invalid session token"); }
}

export type ProvisioningCode =
  | "invalid_token" | "invalid_username" | "forbidden_mode"
  | "blacklisted" | "taken" | "limit_reached" | "invalid_claim" | "invalid_rails"
  | "already_named" | "not_found";

export class ProvisioningError extends AppError {
  readonly kind = "provisioning";
  constructor(readonly code: ProvisioningCode, message: string) { super(message); }
}

export class InvalidRailPolicyError extends AppError {
  readonly kind = "invalid_rail_policy";
}

export class SettingsError extends AppError {
  readonly kind = "invalid_setting";
}

/** Thrown by a quote provider for an unsupported / out-of-range / malformed unit. */
export class QuoteError extends AppError {
  readonly kind = "invalid_quote";
}

/** A refusal safe to quote to the payer verbatim. Anything else a rail throws
 *  stays generic, because it may name a solver, a key, or this server's wiring. */
export class RailRefusedError extends AppError {
  readonly kind = "rail_refused";
}

/** The wallet behind an interactive session did not produce an invoice; the message is written for the payer. */
export class InvoiceRequestError extends AppError {
  readonly kind = "invoice_request_failed";
}

/** No solver produced a usable offline-receive quote. Internal detail, not for the payer. */
export class SolverQuoteError extends AppError {
  readonly kind = "solver_quote_failed";
}

/** A service this server depends on answered with a failure. */
export class UpstreamError extends AppError {
  readonly kind = "upstream_failed";
  constructor(readonly service: string, readonly upstreamStatus: number) {
    super(`${service}: HTTP ${upstreamStatus}`);
  }
}

/** Stored or received data that does not decode: corruption, not a transient failure. */
export class MalformedRecordError extends AppError {
  readonly kind = "malformed_record";
}

export class ConfigError extends AppError {
  readonly kind = "invalid_config";
}

export type DomainError =
  | InvalidSessionTokenError
  | ProvisioningError
  | InvalidRailPolicyError
  | SettingsError
  | QuoteError
  | RailRefusedError
  | InvoiceRequestError
  | SolverQuoteError
  | UpstreamError
  | MalformedRecordError
  | ConfigError;

// A kind with no class in DomainError would never reach an exhaustive switch.
type Assert<T extends true> = T;
export type EveryKindHasAClass = Assert<[Exclude<ErrorKind, DomainError["kind"]>] extends [never] ? true : false>;

export const isDomainError = (err: unknown): err is DomainError => err instanceof AppError;

export function assertUnreachable(value: never): never {
  throw new Error(`unhandled case: ${JSON.stringify(value)}`);
}
