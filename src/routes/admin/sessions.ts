import { Router } from "express";
import { NotFound } from "../../http-errors.js";
import type { AdminDeps } from "../../admin-context.js";

/** Live read of the in-memory SessionManager, joined to the addresses table so each
 *  connection shows who it belongs to. Never exposes the session token or socket. */
export function adminSessionRoutes({ repos, sessions }: AdminDeps): Router {
  const r = Router();
  r.get("/sessions", (_req, res) => res.json(
    sessions.listSessions().map((s) => ({
      sessionId: s.id,
      connectedAt: s.createdAt,
      ip: s.ip ?? null,
      reusable: s.reusable,
      invoicesIssued: s.invoicesIssued,
      lastInvoiceAt: s.lastInvoiceAt ?? null,
      pending: s.pending,
      addresses: repos.addresses.listBySessionId(s.id).map((a) => ({
        username: a.username,
        domain: repos.domains.getById(a.domainId)?.domain ?? null,
        status: a.status,
      })),
    })),
  ));
  r.post("/sessions/:id/disconnect", (req, res) => {
    if (!sessions.disconnect(req.params.id)) throw new NotFound("session not found");
    res.json({ ok: true });
  });
  return r;
}
