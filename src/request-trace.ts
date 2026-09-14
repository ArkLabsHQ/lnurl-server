import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Logger } from "./logger.js";

/** One completion line per response — including a 404 from Express's final
 *  handler, so its absence means the request never reached the process. */
export function requestTraceMiddleware(logger: Logger): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      logger.info("http_request", {
        method: req.method,
        path: req.originalUrl,
        host: req.headers.host,
        status: res.statusCode,
        durationMs: Number(process.hrtime.bigint() - start) / 1e6,
        requestId: res.getHeader("x-request-id"),
        forwardedFor: req.headers["x-forwarded-for"],
        forwardedProto: req.headers["x-forwarded-proto"],
        realIp: req.headers["x-real-ip"],
      });
    });
    next();
  };
}
