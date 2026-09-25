import { Router } from "express";
import { createLogger } from "../../../logger.js";
import { httpErrorHandler } from "../../errors.js";
import type { AdminDeps } from "../../admin-context.js";
import { adminDiscoveryRoutes } from "./discovery.js";
import { adminDomainRoutes } from "./domains.js";
import { adminAddressRoutes } from "./addresses.js";
import { adminReconcileRoutes } from "./reconcile.js";
import { adminApiKeyRoutes } from "./api-keys.js";
import { adminBlacklistRoutes } from "./blacklist.js";
import { adminSessionRoutes } from "./sessions.js";
import { adminSettingsRoutes } from "./settings.js";
import { adminSettlementRoutes } from "./settlements.js";
import { adminDocsRoutes } from "./docs.js";

export type { AdminDeps } from "../../admin-context.js";

/** The admin JSON API, mounted by admin-server.ts at /admin/api. Ends with its own
 *  error handler so the router answers errors the same wherever it is mounted. */
export function createAdminApi(deps: AdminDeps): Router {
  const r = Router();
  r.use(adminDiscoveryRoutes(deps));
  r.use(adminDomainRoutes(deps));
  r.use(adminAddressRoutes(deps));
  r.use(adminReconcileRoutes(deps));
  r.use(adminApiKeyRoutes(deps));
  r.use(adminBlacklistRoutes(deps));
  r.use(adminSessionRoutes(deps));
  r.use(adminSettingsRoutes(deps));
  r.use(adminSettlementRoutes(deps));
  r.use(adminDocsRoutes());
  r.use(httpErrorHandler(deps.logger ?? createLogger()));
  return r;
}
