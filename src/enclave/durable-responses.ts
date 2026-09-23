import type express from "express";
import type { Logger } from "../logger.js";
import type { DurabilityBarrier } from "./checkpoint.js";

const NOT_DURABLE = JSON.stringify({ status: "ERROR", reason: "State could not be made durable; try again" });

/**
 * Holds each buffered response until nothing it could reveal is uncommitted: this
 * request's writes, another request's, or a background worker's. A response whose
 * head is already out (an event stream, a piped file) cannot be held and passes;
 * none of those carries durable state today, so a new one that does must barrier itself.
 */
export function durableResponses(durability: DurabilityBarrier, logger: Logger, exempt: readonly string[] = []): express.RequestHandler {
  return (req, res, next) => {
    if (exempt.includes(req.path)) return next();
    const end = res.end.bind(res) as (...args: unknown[]) => express.Response;
    res.end = ((...args: unknown[]) => {
      if (res.headersSent) return end(...args);
      durability.barrier().then(
        () => end(...args),
        (error: unknown) => {
          logger.warn("response_not_durable", { requestId: res.locals.requestId, path: req.path, error });
          res.statusCode = 503;
          res.removeHeader("ETag");
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Content-Length", Buffer.byteLength(NOT_DURABLE));
          end(NOT_DURABLE);
        },
      );
      return res;
    }) as typeof res.end;
    next();
  };
}
