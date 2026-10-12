import { randomBytes } from "node:crypto";
import type { Logger } from "../logger.js";
import type { SettlementStore, SettlementRecord } from "../settlement-store.js";

export const BATCH_PATH = "/lnurl/verifyBatch";

/** Server-side caps for the batch endpoint. Wire behaviour comes from LUD-XX
 *  `verifyBatch`; these only bound what one connection or request can cost. */
export interface VerifyBatchConfig {
  /** How often an open stream re-checks the store for settlement flips. */
  pollMs: number;
  /** SSE comment cadence so intermediaries do not drop an idle stream. */
  keepaliveMs: number;
  /** Forced stream close after this long; the client re-opens as needed. */
  maxSessionMs: number;
  /** Concurrent streams per process. */
  maxSessions: number;
  /** Verify URLs one stream may track. */
  maxTracked: number;
  /** `verify` URLs accepted in one one-shot snapshot. */
  maxPerRequest: number;
}

export const DEFAULT_VERIFY_BATCH_CONFIG: VerifyBatchConfig = {
  pollMs: 1_000,
  keepaliveMs: 30_000,
  maxSessionMs: 600_000,
  maxSessions: 100,
  maxTracked: 1_000,
  maxPerRequest: 250,
};

/** Extracts the record key (`/lnurl/verify/<key>`) from a verify URL the server
 *  itself handed out. Issuance is judged by the store: a 32-hex verify id or a
 *  64-hex payment hash that resolves there is one the server issued, and
 *  anything else is "unknown verify url". Host is deliberately not checked — a
 *  server reachable under several hostnames honours all of them, exactly like
 *  the single-invoice verify route. */
export function verifyKeyOf(urlString: string): string | undefined {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return undefined;
  }
  const match = /^\/lnurl\/verify\/([0-9a-f]+)$/i.exec(url.pathname);
  // 64 = sha256 payment hash, 32 = the opaque verify id minted for destination quotes.
  if (!match || !/^[0-9a-f]{32}$|^[0-9a-f]{64}$/i.test(match[1])) return undefined;
  return match[1].toLowerCase();
}

/** One entry of the one-shot `results` map and one streamed result frame
 *  payload. Both shapes are identical to the per-invoice verify route — parity
 *  is the contract. */
export type VerifyBatchItem = { status: "OK" } & (LightningItem | DestinationItem);
interface LightningItem {
  settled: boolean;
  preimage: string | null;
  pr: string;
}
interface DestinationItem {
  settled: boolean;
  paymentOption: string;
  paymentDestination?: string;
  paymentReference: string | null;
}

function itemShape(rec: SettlementRecord): VerifyBatchItem {
  if (rec.paymentOption !== "lightning") {
    return {
      status: "OK",
      settled: rec.settled,
      paymentOption: rec.paymentOption,
      ...(rec.paymentDestination ? { paymentDestination: rec.paymentDestination } : {}),
      paymentReference: rec.paymentReference,
    };
  }
  return { status: "OK", settled: rec.settled, preimage: rec.settled ? rec.preimage : null, pr: rec.pr };
}

const UNKNOWN: { status: "ERROR"; reason: "unknown verify url" } = { status: "ERROR", reason: "unknown verify url" };

/** Bookkeeping per tracked URL: the record key and the last state seen. */
interface Tracked {
  key: string;
  /** "pending" is the only state that can still change; it flips once. */
  lastSeen: "pending" | "settled" | "unknown" | "expired";
}

const isTerminal = (t: Tracked): boolean => t.lastSeen !== "pending";

/** What a stream writes to; an HTTP response satisfies it. */
export interface StreamSink {
  write(chunk: string): unknown;
  end(): unknown;
  readonly writableEnded: boolean;
}

interface BatchSession {
  token: string;
  sink: StreamSink;
  /** Tracked verify URL -> state; the URL is the byte-for-byte echo. */
  tracked: Map<string, Tracked>;
  /** Frames from a session update, flushed at the next poll tick. */
  queue: string[];
  keepaliveAt: number;
  expiresAt: number;
  closed: boolean;
}

export type UpdateOutcome = "ok" | "unknown_session" | "nothing_to_change" | "too_many";

export interface VerifyBatch {
  readonly config: VerifyBatchConfig;
  /** One-shot results keyed by the exact URL strings presented, once per distinct URL. */
  snapshot(urls: readonly string[]): Record<string, VerifyBatchItem | typeof UNKNOWN>;
  canOpenStream(): boolean;
  /** Writes the session frame and the snapshot burst, then streams settlements. */
  openStream(urls: readonly string[], sink: StreamSink): string;
  closeStream(token: string, reason?: string): void;
  update(token: string, add: readonly string[], remove: readonly string[]): UpdateOutcome;
  /** Live stream count, for readiness introspection. */
  liveSessions(): number;
  /** Idempotent teardown of every stream and the poll timer. */
  stop(reason?: string): void;
}

export function createVerifyBatch(deps: {
  store: SettlementStore;
  logger: Pick<Logger, "info" | "warn" | "error">;
  config?: Partial<VerifyBatchConfig>;
}): VerifyBatch {
  const config: VerifyBatchConfig = { ...DEFAULT_VERIFY_BATCH_CONFIG, ...deps.config };
  const { store, logger } = deps;
  const sessions = new Map<string, BatchSession>();
  let timer: NodeJS.Timeout | undefined;

  const stopTimer = (): void => {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
  };

  /** Returns false when the transport is gone; every caller closes the session then. */
  const writeFrame = (s: BatchSession, raw: string): boolean => {
    if (s.closed || s.sink.writableEnded) return false;
    try {
      s.sink.write(raw);
      return true;
    } catch {
      return false;
    }
  };

  /** `event` rides its own line, so `{ event: "session" }` must be passed as a
   *  trailing line already terminated with `\n`. */
  const frame = (body: Record<string, unknown>, event?: string): string =>
    event ? `${event}data: ${JSON.stringify(body)}\n\n` : `data: ${JSON.stringify(body)}\n\n`;

  const track = (url: string): { tracked: Tracked; item: VerifyBatchItem | typeof UNKNOWN } => {
    const key = verifyKeyOf(url);
    const rec = key ? store.get(key) : undefined;
    return rec
      ? { tracked: { key: key!, lastSeen: rec.settled ? "settled" : "pending" }, item: itemShape(rec) }
      : { tracked: { key: "", lastSeen: "unknown" }, item: UNKNOWN };
  };

  function flushQueue(s: BatchSession): void {
    if (s.queue.length === 0) return;
    const queued = s.queue;
    s.queue = [];
    for (const raw of queued) {
      if (!writeFrame(s, raw)) break;
    }
  }

  function closeSession(s: BatchSession, reason?: string): void {
    if (s.closed) return;
    // Frames the client was owed must still land: a stream that closes with a
    // pending removal would leave the client's set-divergence unreconciled.
    flushQueue(s);
    s.closed = true;
    sessions.delete(s.token);
    try {
      s.sink.end();
    } catch {
      /* already gone */
    }
    if (reason) logger.info("verify_batch_session_closed", { token: s.token, reason });
    if (sessions.size === 0) stopTimer();
  }

  const closeIfSettled = (s: BatchSession): boolean => {
    if (s.tracked.size !== 0 && ![...s.tracked.values()].every(isTerminal)) return false;
    closeSession(s, s.tracked.size === 0 ? "nothing tracked" : "everything settled");
    return true;
  };

  function startTimer(): void {
    // unref: an open stream must not pin the event loop once the process is
    // asked to exit — server close emits the res "close" events and we clean up.
    if (!timer) timer = setInterval(tick, config.pollMs).unref();
  }

  function tick(): void {
    const now = Date.now();
    for (const s of [...sessions.values()]) {
      if (s.closed) continue;
      flushQueue(s);
      if (now >= s.expiresAt) {
        closeSession(s, "max duration");
        continue;
      }
      if (now - s.keepaliveAt >= config.keepaliveMs) {
        if (!writeFrame(s, ": keepalive\n\n")) {
          closeSession(s, "transport closed");
          continue;
        }
        s.keepaliveAt = now;
      }
      // One frame per pending flip. Expiry is never streamed: the record just
      // vanishes and the client drops the invoice locally, per spec.
      for (const [url, t] of s.tracked) {
        if (t.lastSeen !== "pending") continue;
        const rec = store.get(t.key);
        if (!rec) {
          t.lastSeen = "expired";
          continue;
        }
        if (rec.settled) {
          t.lastSeen = "settled";
          if (!writeFrame(s, frame({ verify: url, ...itemShape(rec) }))) {
            closeSession(s, "transport closed");
            break;
          }
        }
      }
      closeIfSettled(s);
    }
  }

  return {
    config,

    snapshot(urls) {
      const results: Record<string, VerifyBatchItem | typeof UNKNOWN> = Object.create(null);
      for (const url of urls) results[url] = track(url).item;
      return results;
    },

    canOpenStream: () => sessions.size < config.maxSessions,

    openStream(urls, sink) {
      const session: BatchSession = {
        token: randomBytes(32).toString("hex"),
        sink,
        tracked: new Map(),
        queue: [],
        keepaliveAt: Date.now(),
        expiresAt: Date.now() + config.maxSessionMs,
        closed: false,
      };
      sessions.set(session.token, session);
      // Required first frame, then the snapshot burst, then live settlements.
      if (!writeFrame(session, frame({ session: session.token }, "event: session\n"))) {
        closeSession(session, "transport closed");
        return session.token;
      }
      // One frame per distinct URL, one-shot or streaming.
      for (const url of new Set(urls)) {
        const { tracked, item } = track(url);
        session.tracked.set(url, tracked);
        if (!writeFrame(session, frame({ verify: url, ...item }))) {
          closeSession(session, "transport closed");
          return session.token;
        }
      }
      if (!closeIfSettled(session)) startTimer();
      return session.token;
    },

    closeStream(token, reason) {
      const session = sessions.get(token);
      if (session) closeSession(session, reason);
    },

    update(token, add, remove) {
      const session = sessions.get(token);
      if (!session) return "unknown_session";
      if (add.length === 0 && remove.length === 0) return "nothing_to_change";
      if (session.tracked.size + add.length > config.maxTracked) return "too_many";
      // Removals queue first so a URL moved between groups in one request gives
      // the documented frame order: removed, then the new snapshot.
      for (const url of remove) {
        if (!session.tracked.delete(url)) continue; // untracked removal is a no-op
        session.queue.push(frame({ verify: url }, "event: removed\n"));
      }
      for (const url of add) {
        if (session.tracked.has(url)) continue; // re-adding a tracked URL is a no-op
        const { tracked, item } = track(url);
        session.tracked.set(url, tracked);
        session.queue.push(frame({ verify: url, ...item }));
      }
      // Everything terminal right now (removals emptied the set, or the last adds
      // all arrived settled): flush the owed frames, then stop watching.
      if (!closeIfSettled(session)) startTimer();
      return "ok";
    },

    liveSessions: () => sessions.size,

    stop(reason = "shutdown") {
      for (const s of [...sessions.values()]) {
        logger.info("verify_batch_session_closed", { token: s.token, reason });
        s.closed = true;
        try {
          s.sink.end();
        } catch {
          /* already gone */
        }
      }
      sessions.clear();
      stopTimer();
    },
  };
}
