import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { SessionManager } from "./services/sessions.js";
import { MemorySettlementStore } from "./settlement-store.js";
import { HealthRegistry } from "./health.js";
import { createLogger } from "./logger.js";
import { currentRailCaps } from "./rails.js";
import { staticSettings, type RuntimeSettings } from "./services/settings.js";
import { requestTraceMiddleware } from "./request-trace.js";
import type { LnurlServiceConfig } from "./types/index.js";
import { httpErrorHandler, lnurlErrorHandler } from "./http-errors.js";
import type { ServerContext, ServerDeps } from "./server-context.js";
import { healthRoutes } from "./routes/health.js";
import { docsRoutes } from "./routes/docs.js";
import { lnurlSessionRoutes } from "./routes/lnurl-session.js";
import { lnurlAddressRoutes } from "./routes/lnurl-address.js";
import { lnurlPayRoutes } from "./routes/lnurl-pay.js";
import { wellKnownRoutes } from "./routes/well-known.js";

export type { ServerDeps } from "./server-context.js";

const DEFAULT_INVOICE_TIMEOUT_MS = 30_000;

export function createServer(config: LnurlServiceConfig, deps?: ServerDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  const logger = deps?.logger ?? createLogger();
  if (config.traceRequests) app.use(requestTraceMiddleware(logger));
  // Soft settings are read per-request so DB-backed overrides take effect without a restart.
  // No DB (library/in-memory mode) → fall back to the static config values.
  const settings: RuntimeSettings = deps?.settings ?? staticSettings({
    minSendable: config.minSendable,
    maxSendable: config.maxSendable,
    invoiceTimeoutMs: config.invoiceTimeoutMs ?? DEFAULT_INVOICE_TIMEOUT_MS,
    baseUrl: config.baseUrl,
    registrationRateLimitPerMin: 10,
  });
  const ctx: ServerContext = {
    ...deps,
    config,
    logger,
    settings,
    sessions: deps?.sessions ?? new SessionManager(),
    // LUD-21 settlement records. DB-backed when provided, else in-memory with TTL.
    store: deps?.settlements ?? new MemorySettlementStore(config.verifyTtlMs ?? 86_400_000),
    currentRailCaps: () => currentRailCaps(deps),
  };

  // Default: trust exactly one proxy hop so req.ip reflects the real client IP behind
  // a single LB/CDN. Set trustProxy to a higher number for deeper proxy stacks, or false
  // to disable entirely (direct connections only).
  app.set("trust proxy", config.trustProxy ?? 1);

  app.use(
    cors({
      // An explicit list replaces cors's default of reflecting the requested
      // headers, so anything a route reads must appear here or the browser
      // drops the request at the preflight with an opaque CORS error rather
      // than the status the route would have returned.
      origin: true,
      allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
      exposedHeaders: ["X-Request-Id"],
    }),
  );
  app.use(express.json({ limit: "64kb" }));
  app.use((_req, res, next) => {
    const requestId = randomUUID();
    res.locals.requestId = requestId;
    res.setHeader("X-Request-Id", requestId);
    next();
  });

  app.use(healthRoutes(deps?.health ?? new HealthRegistry()));
  app.use(docsRoutes());
  app.use(lnurlSessionRoutes(ctx));
  // Before lnurlPayRoutes: GET /lnurl/address would otherwise match /lnurl/:id.
  app.use(lnurlAddressRoutes(ctx));
  // Before lnurlPayRoutes: a flagged address's session LNURL is served as the address.
  if (ctx.repos) app.use(wellKnownRoutes(ctx, ctx.repos));
  app.use(lnurlPayRoutes(ctx));

  app.use(lnurlErrorHandler);
  app.use(httpErrorHandler(logger));
  return app;
}
