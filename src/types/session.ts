import type { Response } from "express";

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
