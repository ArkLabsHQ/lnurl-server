import { randomBytes } from "node:crypto";
import express from "express";
import type { Logger } from "./logger.js";
import { RateLimiter } from "./rate-limit.js";
import type { SettlementStore, SettlementRecord } from "./settlement-store.js";

const BATCH_PATH = "/lnurl/verifyBatch";

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

interface BatchSession {
  token: string;
  res: express.Response;
  /** Tracked verify URL -> state; the URL is the byte-for-byte echo. */
  tracked: Map<string, Tracked>;
  /** Frames from a session update, flushed at the next poll tick. */
  queue: string[];
  keepaliveAt: number;
  expiresAt: number;
  closed: boolean;
}

export interface VerifyBatchManager {
  /** Live stream count, for readiness introspection. */
  liveSessions(): number;
  /** Idempotent teardown of every stream and the poll timer. */
  stop(reason?: string): void;
}

export interface VerifyBatchDeps {
  store: SettlementStore;
  verifyLimiter: RateLimiter;
  logger: Pick<Logger, "info" | "warn" | "error">;
  config?: Partial<VerifyBatchConfig>;
}

/** Collects a repeated query parameter: `?verify=a&verify=b` reads as
 *  `string[]`, a single occurrence as `[string]`. Anything else is refused. */
function stringList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[];
  return undefined;
}

/** Wires `GET /lnurl/verifyBatch` (one-shot, streamed and session update forms)
 *  onto the app. MUST be registered before `GET /lnurl/:id`. */
export function attachVerifyBatchRoute(app: express.Express, deps: VerifyBatchDeps): VerifyBatchManager {
  const cfg: VerifyBatchConfig = { ...DEFAULT_VERIFY_BATCH_CONFIG, ...deps.config };
  const { store, verifyLimiter, logger } = deps;

  const sessions = new Map<string, BatchSession>();
  let timer: NodeJS.Timeout | undefined;

  const stopTimer = (): void => {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
  };

  /** Returns false when the transport is gone; every caller closes the session then. */
  const writeFrame = (s: BatchSession, raw: string): boolean => {
    if (s.closed || s.res.writableEnded) return false;
    try {
      s.res.write(raw);
      return true;
    } catch {
      return false;
    }
  };

  /** `event` rides its own line, so `{ event: "session" }` must be passed as a
   *  trailing line already terminated with `\n`. */
  const frame = (body: Record<string, unknown>, event?: string): string =>
    event ? `${event}data: ${JSON.stringify(body)}\n\n` : `data: ${JSON.stringify(body)}\n\n`;

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
      s.res.end();
    } catch {
      /* already gone */
    }
    if (reason) logger.info("verify_batch_session_closed", { token: s.token, reason });
    if (sessions.size === 0) stopTimer();
  }

  function startTimer(): void {
    // unref: an open stream must not pin the event loop once the process is
    // asked to exit — server close emits the res "close" events and we clean up.
    if (!timer) timer = setInterval(tick, cfg.pollMs).unref();
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
      if (now - s.keepaliveAt >= cfg.keepaliveMs) {
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
      if (s.tracked.size === 0 || [...s.tracked.values()].every(isTerminal)) {
        closeSession(s, s.tracked.size === 0 ? "nothing tracked" : "everything settled");
      }
    }
  }

  /** One off well-formed request → `{status:"OK", results}` keyed by the exact
   *  URL strings the caller presented, once per distinct URL. */
  function handleOneShot(req: express.Request, res: express.Response): void {
    res.setHeader("Cache-Control", "no-store");
    if (!verifyLimiter.allow(req.ip ?? "unknown")) {
      res.status(429).json({ status: "ERROR", reason: "Too many requests" });
      return;
    }
    const verify = stringList(req.query.verify);
    if (!verify || verify.length === 0) {
      res.status(400).json({ status: "ERROR", reason: "verify parameter required" });
      return;
    }
    if (verify.length > cfg.maxPerRequest) {
      res.status(414).json({ status: "ERROR", reason: `at most ${cfg.maxPerRequest} verify URLs per request` });
      return;
    }
    // The key alone decides issuance, the URL string drives the echo: express
    // decodes the wire value, which is exactly the URL the payer takes from the
    // callback response and looks up by.
    const results: Record<string, VerifyBatchItem | typeof UNKNOWN> = Object.create(null);
    for (const url of verify) {
      const key = verifyKeyOf(url);
      const rec = key ? store.get(key) : undefined;
      results[url] = rec ? itemShape(rec) : UNKNOWN;
    }
    res.json({ status: "OK", results });
  }

  function handleStream(req: express.Request, res: express.Response): void {
    if (!verifyLimiter.allow(req.ip ?? "unknown") || sessions.size >= cfg.maxSessions) {
      res.status(429).json({ status: "ERROR", reason: "Too many requests" });
      return;
    }
    const verify = stringList(req.query.verify);
    if (!verify || verify.length === 0) {
      res.status(400).json({ status: "ERROR", reason: "verify parameter required" });
      return;
    }
    if (verify.length > cfg.maxTracked) {
      res.status(414).json({ status: "ERROR", reason: `at most ${cfg.maxTracked} verify URLs per stream` });
      return;
    }
    // One frame per distinct URL, one-shot or streaming.
    const seen = new Set<string>();
    const urls = verify.filter((u) => (seen.has(u) ? false : (seen.add(u), true)));

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });

    const session: BatchSession = {
      token: randomBytes(32).toString("hex"),
      res,
      tracked: new Map(),
      queue: [],
      keepaliveAt: Date.now(),
      expiresAt: Date.now() + cfg.maxSessionMs,
      closed: false,
    };
    sessions.set(session.token, session);
    // Required first frame, then the snapshot burst, then live settlements.
    if (!writeFrame(session, frame({ session: session.token }, "event: session\n"))) {
      closeSession(session, "transport closed");
      return;
    }
    let allTerminal = true;
    for (const url of urls) {
      const key = verifyKeyOf(url);
      const rec = key ? store.get(key) : undefined;
      const tracked: Tracked = rec
        ? { key: key!, lastSeen: rec.settled ? "settled" : "pending" }
        : { key: "", lastSeen: "unknown" };
      session.tracked.set(url, tracked);
      if (!writeFrame(session, frame({ verify: url, ...(rec ? itemShape(rec) : UNKNOWN) }))) {
        closeSession(session, "transport closed");
        return;
      }
      if (!isTerminal(tracked)) allTerminal = false;
    }
    res.on("close", () => closeSession(session, "transport closed"));
    if (allTerminal) closeSession(session, "everything settled");
    else startTimer();
  }

  function handleUpdate(req: express.Request, res: express.Response, sessionToken: string): void {
    if (!verifyLimiter.allow(req.ip ?? "unknown")) {
      res.status(429).json({ status: "ERROR", reason: "Too many requests" });
      return;
    }
    const session = sessions.get(sessionToken);
    if (!session) {
      res.status(404).json({ status: "ERROR", reason: "unknown session" });
      return;
    }
    const add = stringList(req.query.add) ?? [];
    const remove = stringList(req.query.remove) ?? [];
    if (add.length === 0 && remove.length === 0) {
      res.status(400).json({ status: "ERROR", reason: "add or remove required" });
      return;
    }
    if (session.tracked.size + add.length > cfg.maxTracked) {
      res.status(400).json({ status: "ERROR", reason: `at most ${cfg.maxTracked} verify URLs per stream` });
      return;
    }

    // Removals queue first so a URL moved between groups in one request gives
    // the documented frame order: removed, then the new snapshot.
    for (const url of remove) {
      if (!session.tracked.delete(url)) continue; // untracked removal is a no-op
      session.queue.push(frame({ verify: url }, "event: removed\n"));
    }
    for (const url of add) {
      if (session.tracked.has(url)) continue; // re-adding a tracked URL is a no-op
      const key = verifyKeyOf(url);
      const rec = key ? store.get(key) : undefined;
      session.tracked.set(url, rec ? { key: key!, lastSeen: rec.settled ? "settled" : "pending" } : { key: "", lastSeen: "unknown" });
      session.queue.push(frame({ verify: url, ...(rec ? itemShape(rec) : UNKNOWN) }));
    }

    // Everything terminal right now (removals emptied the set, or the last adds
    // all arrived settled): flush the owed frames, then stop watching.
    if (session.tracked.size === 0 || [...session.tracked.values()].every(isTerminal)) {
      closeSession(session, session.tracked.size === 0 ? "nothing tracked" : "everything settled");
    } else {
      startTimer();
    }
    res.json({ status: "OK" });
  }

  app.get(BATCH_PATH, (req, res) => {
    // A `session` parameter selects the update form; otherwise Accept picks stream or snapshot.
    const sessionParam = [...(Array.isArray(req.query.session) ? req.query.session : [req.query.session])]
      .find((v): v is string => typeof v === "string");
    if (sessionParam !== undefined) {
      handleUpdate(req, res, sessionParam);
      return;
    }
    if ((req.headers.accept ?? "").includes("text/event-stream")) handleStream(req, res);
    else handleOneShot(req, res);
  });

  function stop(reason = "shutdown"): void {
    const all = [...sessions.values()];
    for (const s of all) {
      logger.info("verify_batch_session_closed", { token: s.token, reason });
      s.closed = true;
      try {
        s.res.end();
      } catch {
        /* already gone */
      }
    }
    sessions.clear();
    stopTimer();
  }

  return { liveSessions: () => sessions.size, stop };
}

export { BATCH_PATH };
