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
  /** How long (ms) a handed-out destination stays watched, and so how long a
   *  payment to it can still be attributed (default: 7d). @see LnurlPayDestinationResponse.expiresAt */
  destinationWatchMs?: number;
  /** Trust X-Forwarded-* headers from a reverse proxy (default: 1 hop). Pass a number for
   *  the hop count, true to trust all, or false to disable. */
  trustProxy?: number | boolean;
  /** Log one structured completion line per request (default: off). */
  traceRequests?: boolean;
  maxSessions?: number;
  maxSessionsPerIp?: number;
  maxConcurrentOfflineQuotes?: number;
  /** LUD-XX `verifyBatch` endpoint caps. Absent leaves every default. */
  verifyBatch?: Partial<import("../verify-batch.js").VerifyBatchConfig>;
}
