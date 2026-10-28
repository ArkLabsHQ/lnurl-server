import { Router } from "express";
import { Conflict, NotFound } from "../../errors.js";
import type { AdminDeps } from "../../admin-context.js";
import { idParam, strParam } from "../../params.js";

/** Free-name claim codes. A reserved name's code is issued with the reservation, under /addresses. */
export function adminClaimCodeRoutes(deps: AdminDeps): Router {
  const { repos, addressService } = deps;
  const r = Router();

  r.get("/claim-codes", (req, res) => {
    const domainId = req.query.domainId === undefined ? undefined : idParam(strParam(req.query.domainId) ?? "");
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
    const outcome = repos.claimCodes.revoke(idParam(req.params.id));
    if (outcome === "missing") throw new NotFound("claim code not found");
    if (outcome === "spent") throw new Conflict("a spent claim code stays as the record of the address it claimed");
    res.json({ ok: true });
  });

  return r;
}
