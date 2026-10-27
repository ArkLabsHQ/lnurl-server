import { Router } from "express";
import { NotFound } from "../../errors.js";
import type { AdminDeps } from "../../admin-context.js";
import { idParam } from "../../params.js";

/** Free-name claim codes. A reserved name's code is issued with the reservation, under /addresses. */
export function adminClaimCodeRoutes(deps: AdminDeps): Router {
  const { repos, addressService } = deps;
  const r = Router();

  r.get("/claim-codes", (req, res) => {
    const domainId = req.query.domainId ? Number(req.query.domainId) : undefined;
    res.json({
      claimCodes: repos.claimCodes.list(domainId).map((c) => ({
        id: c.id, domain: repos.domains.getById(c.domainId)?.domain ?? null,
        createdAt: c.createdAt, redeemedAt: c.redeemedAt, username: c.username,
      })),
    });
  });
  r.post("/claim-codes", (req, res) => {
    const { domain: domainName } = (req.body ?? {}) as { domain?: string };
    const domain = domainName ? repos.domains.getByDomain(domainName) : undefined;
    if (!domain) throw new NotFound("unknown domain");
    const { code, claimCode } = addressService.issueClaimCode(domain);
    res.status(201).json({ id: code.id, domain: domain.domain, claimCode });
  });
  r.delete("/claim-codes/:id", (req, res) => {
    if (!repos.claimCodes.delete(idParam(req.params.id))) throw new NotFound("claim code not found");
    res.json({ ok: true });
  });

  return r;
}
