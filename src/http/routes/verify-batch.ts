import { Router, type Request } from "express";
import type { RateLimiter } from "../../rate-limit.js";
import { BATCH_PATH, type VerifyBatch } from "../../services/verify-batch.js";
import { LnurlError } from "../errors.js";

/** Collects a repeated query parameter: `?verify=a&verify=b` reads as
 *  `string[]`, a single occurrence as `[string]`. Anything else is refused. */
function stringList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[];
  return undefined;
}

/** LUD-XX `GET /lnurl/verifyBatch`: one-shot, streamed and session-update forms.
 *  MUST be mounted before `GET /lnurl/:id`, which would take the literal path. */
export function verifyBatchRoutes(batch: VerifyBatch, verifyLimiter: RateLimiter): Router {
  const r = Router();
  const { maxPerRequest, maxTracked } = batch.config;
  const allow = (req: Request): boolean => verifyLimiter.allow(req.ip ?? "unknown");

  const verifyList = (req: Request, max: number, per: string): string[] => {
    const verify = stringList(req.query.verify);
    if (!verify || verify.length === 0) throw new LnurlError("verify parameter required", 400);
    if (verify.length > max) throw new LnurlError(`at most ${max} verify URLs per ${per}`, 414);
    return verify;
  };

  r.get(BATCH_PATH, (req, res) => {
    // A `session` parameter selects the update form; otherwise Accept picks stream or snapshot.
    const sessionParam = [...(Array.isArray(req.query.session) ? req.query.session : [req.query.session])]
      .find((v): v is string => typeof v === "string");

    if (sessionParam !== undefined) {
      if (!allow(req)) throw new LnurlError("Too many requests", 429);
      const outcome = batch.update(sessionParam, stringList(req.query.add) ?? [], stringList(req.query.remove) ?? []);
      if (outcome === "unknown_session") throw new LnurlError("unknown session", 404);
      if (outcome === "nothing_to_change") throw new LnurlError("add or remove required", 400);
      if (outcome === "too_many") throw new LnurlError(`at most ${maxTracked} verify URLs per stream`, 400);
      res.json({ status: "OK" });
      return;
    }

    if ((req.headers.accept ?? "").includes("text/event-stream")) {
      if (!allow(req) || !batch.canOpenStream()) throw new LnurlError("Too many requests", 429);
      const urls = verifyList(req, maxTracked, "stream");
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      const token = batch.openStream(urls, res);
      res.on("close", () => batch.closeStream(token, "transport closed"));
      return;
    }

    res.setHeader("Cache-Control", "no-store");
    if (!allow(req)) throw new LnurlError("Too many requests", 429);
    // The key alone decides issuance, the URL string drives the echo: express
    // decodes the wire value, which is exactly the URL the payer takes from the
    // callback response and looks up by.
    res.json({ status: "OK", results: batch.snapshot(verifyList(req, maxPerRequest, "request")) });
  });

  return r;
}
