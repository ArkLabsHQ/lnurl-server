import type { Response } from "express";

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
  /** SSE response object for streaming events to wallet */
  sseRes: Response;
  /** Pending invoice request resolver — set when payer is waiting */
  pendingInvoice: {
    resolve: (pr: string) => void;
    reject: (err: Error) => void;
  } | null;
}

/** LNURL-pay first-call response (LUD-06) */
export interface LnurlPayMetadata {
  callback: string;
  minSendable: number;
  maxSendable: number;
  metadata: string;
  tag: "payRequest";
  commentAllowed?: number;
}

/** LNURL-pay callback response */
export interface LnurlPayCallbackResponse {
  pr: string;
  routes: never[];
}

/** LNURL error response */
export interface LnurlErrorResponse {
  status: "ERROR";
  reason: string;
}
