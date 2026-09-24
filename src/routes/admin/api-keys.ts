import { Router } from "express";
import type { AdminDeps } from "../../admin-context.js";

export function adminApiKeyRoutes({ repos }: AdminDeps): Router {
  const r = Router();
  r.get("/api-keys", (_req, res) => res.json(repos.apiKeys.list()));
  r.post("/api-keys", (req, res) => {
    const { label, domainId } = (req.body ?? {}) as { label?: string; domainId?: number };
    const { raw, row } = repos.apiKeys.create({ label, domainId: domainId ?? null });
    res.status(201).json({ ...row, key: raw });
  });
  r.delete("/api-keys/:id", (req, res) => { repos.apiKeys.revoke(Number(req.params.id)); res.json({ ok: true }); });
  return r;
}
