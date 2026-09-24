import express from "express";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdminApi, type AdminDeps } from "./admin-api.js";
import { randomUUID } from "node:crypto";
import { createLogger } from "./logger.js";
import { requestTraceMiddleware } from "./request-trace.js";
import { httpErrorHandler } from "./http-responses.js";

/** Admin app: JSON API under /admin/api, plus the built SPA (when present) with SPA fallback.
 *  No built-in auth — bind to loopback and front with a proxy. */
export function createAdminServer(deps: AdminDeps, uiDir?: string): express.Express {
  const app = express();
  app.disable("x-powered-by");
  const logger = deps.logger ?? createLogger();
  if (deps.config.traceRequests) app.use(requestTraceMiddleware(logger));
  app.use(express.json({ limit: "256kb" }));
  app.use((_req, res, next) => { res.setHeader("X-Request-Id", randomUUID()); next(); });
  app.use("/admin/api", createAdminApi(deps));

  const dir = uiDir ?? join(dirname(fileURLToPath(import.meta.url)), "admin-ui");
  if (existsSync(dir)) {
    app.use(express.static(dir));
    app.use((req, res, next) => {
      if (req.method !== "GET" || req.path.startsWith("/admin/api")) return next();
      res.sendFile(join(dir, "index.html"));
    });
  }
  app.use(httpErrorHandler(logger));
  return app;
}
