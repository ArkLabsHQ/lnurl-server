import { Router } from "express";
import { BadRequest } from "../../errors.js";
import type { AdminDeps } from "../../admin-context.js";
import { idParam } from "../../params.js";

export function adminBlacklistRoutes({ repos }: AdminDeps): Router {
  const r = Router();
  r.get("/blacklist", (req, res) =>
    res.json(req.query.domainId ? repos.blacklist.list(Number(req.query.domainId)) : repos.blacklist.listAll()),
  );
  r.post("/blacklist", (req, res) => {
    const { username, domainId, reason } = (req.body ?? {}) as { username?: string; domainId?: number; reason?: string };
    if (!username) throw new BadRequest("username required");
    res.status(201).json(repos.blacklist.add({ domainId: domainId ?? null, username, reason }));
  });
  r.delete("/blacklist/:id", (req, res) => { repos.blacklist.remove(idParam(req.params.id)); res.json({ ok: true }); });
  return r;
}
