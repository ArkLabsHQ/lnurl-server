import type { Response } from "express";
import type { PaymentOption } from "./payment-options.js";

/** Configuration for starting the LNURL service */
export interface LnurlServiceConfig {
  /** Port to listen on */
  port: number;
  /** Public-facing base URL for generating LNURLs (e.g. https://lnurl.example.com) */
  baseUrl: string;
  /** Min receivable amount in millisats (LNURL spec uses millisats) */
  minSendable: number;
  /** Max receivable amount in millisats */
  maxSendable: number;
  /** Timeout in ms for waiting for wallet to provide bolt11 (default: 30000) */
  invoiceTimeoutMs?: number;
  /** How long (ms) a LUD-21 settlement record is retained for `verify` polling (default: 24h) */
  verifyTtlMs?: number;
  /** Trust X-Forwarded-* headers from a reverse proxy (default: 1 hop). Pass a number for
   *  the hop count, true to trust all, or false to disable. */
  trustProxy?: number | boolean;
}

/** SSE event types sent to the wallet */
export type SessionEventType =
  | "session_created"
  | "invoice_request"
  | "invoice_settled"
  | "error";

/** Event sent over SSE to the wallet */
export interface SessionEvent {
  type: SessionEventType;
  data: Record<string, unknown>;
}

/** Invoice request sent to wallet via SSE */
export interface InvoiceRequest {
  /** Amount in millisats requested by the payer */
  amountMsat: number;
  /** Optional payer comment */
  comment?: string;
}

/** Payload the wallet POSTs back with the bolt11 */
export interface InvoiceResponse {
  /** BOLT11 invoice string */
  pr: string;
}

/** Internal session state */
export interface Session {
  id: string;
  /** Secret token only the wallet knows (sent via SSE, required for invoice POSTs) */
  token: string;
  createdAt: number;
  /** Client IP at connect time (as seen through `trust proxy`); undefined if unknown. */
  ip?: string;
  /** True when the sessionId was derived from a wallet-provided token (reconnectable),
   *  false for an ephemeral random session that dies with the connection. */
  reusable: boolean;
  /** Count of invoices successfully handed back to payers over this session's lifetime. */
  invoicesIssued: number;
  /** Epoch ms of the last invoice this session resolved; undefined if none yet. */
  lastInvoiceAt?: number;
  /** SSE response object for streaming events to wallet */
  sseRes: Response;
  /** Pending invoice request resolver — set when payer is waiting */
  pendingInvoice: {
    /** Amount the waiting payer requested, in millisats. */
    amountMsat: number;
    /** Optional payer comment. */
    comment?: string;
    /** Epoch ms when the payer's request started waiting. */
    since: number;
    resolve: (pr: string) => void;
    reject: (err: Error) => void;
  } | null;
}

/** Safe, serialisable view of a live session for the admin API — never the token or socket. */
export interface SessionInfo {
  id: string;
  createdAt: number;
  ip?: string;
  reusable: boolean;
  invoicesIssued: number;
  lastInvoiceAt?: number;
  pending: { amountMsat: number; comment?: string; since: number } | null;
}

/** LNURL-pay first-call response (LUD-06) */
export interface LnurlPayMetadata {
  callback: string;
  minSendable: number;
  maxSendable: number;
  metadata: string;
  tag: "payRequest";
  commentAllowed?: number;
  /** LUD-XX: advertised payment rails. Omitted when only lightning is offered. */
  paymentOptions?: PaymentOption[];
}

/** LNURL-pay callback response (BOLT11 / lightning) */
export interface LnurlPayCallbackResponse {
  pr: string;
  routes: never[];
  /** LUD-21: URL the payer can poll to confirm settlement. Omitted if the bolt11 can't be decoded. */
  verify?: string;
}

/** LUD-XX callback response for a non-`pr` payment option (e.g. a direct Arkade destination). */
export interface LnurlPayDestinationResponse {
  status: "OK";
  paymentOption: string;
  paymentDestination?: string;
  verify?: string;
}

/** LNURL error response */
export interface LnurlErrorResponse {
  status: "ERROR";
  reason: string;
}
