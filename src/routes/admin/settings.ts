import { Router } from "express";
import { isSettingKey } from "../../services/settings.js";
import { BadRequest } from "../../http-errors.js";
import type { AdminDeps } from "../../admin-context.js";

/** Editable "soft" settings (env default + DB override) plus a read-only view of the
 *  process/secret config that can only change via env + restart. */
export function adminSettingsRoutes({ settings, config }: AdminDeps): Router {
  const r = Router();
  r.get("/settings", (_req, res) => res.json({
    editable: settings.view(),
    readOnly: {
      port: config.port,
      adminPort: config.adminPort,
      adminBind: config.adminBind,
      dbPath: config.dbPath ?? null,
      trustProxy: config.trustProxy,
      bootstrapDomain: config.bootstrapDomain ?? null,
      tokenEncryptionKey: config.tokenEncryptionKey ? "set" : config.allowInsecureTokenStorage ? "insecure fallback" : "unset",
    },
  }));
  r.patch("/settings", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(body)) {
      if (!isSettingKey(k)) throw new BadRequest(`unknown setting: ${k}`);
      settings.set(k, v);
    }
    res.json(settings.view());
  });
  r.delete("/settings/:key", (req, res) => {
    if (!isSettingKey(req.params.key)) throw new BadRequest("unknown setting");
    settings.clear(req.params.key);
    res.json(settings.view());
  });
  return r;
}
