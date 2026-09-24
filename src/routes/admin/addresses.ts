import { Router } from "express";
import type { AddressStatus } from "../../types/index.js";
import { effectiveRails } from "../../rails.js";
import { BadRequest, NotFound } from "../../http-responses.js";
import { adminRailCaps, type AdminDeps } from "../../admin-context.js";

export function adminAddressRoutes(deps: AdminDeps): Router {
  const { repos, addressService, sessions } = deps;
  const r = Router();

  r.get("/addresses", (req, res) => {
    const online = new Set(sessions.activeSessionIds());
    const rows = repos.addresses.list({
      domainId: req.query.domainId ? Number(req.query.domainId) : undefined,
      status: req.query.status as AddressStatus | undefined,
      q: req.query.q as string | undefined,
    });
    res.json(rows.map((a) => {
      const domain = repos.domains.getById(a.domainId);
      return {
        id: a.id, username: a.username, domain: domain?.domain ?? null, status: a.status,
        sessionId: a.sessionId, online: a.sessionId ? online.has(a.sessionId) : false, createdAt: a.createdAt,
        disabledRails: a.disabledRails,
        rails: effectiveRails({ arkadeAddress: a.arkadeAddress, claimPublicKey: a.claimPublicKey, boardingAddress: a.boardingAddress, disabledRails: a.disabledRails }, adminRailCaps(deps)),
      };
    }));
  });
  r.post("/addresses", (req, res) => {
    const { domain: domainName, username, mode } = (req.body ?? {}) as { domain?: string; username?: string; mode?: string };
    const domain = domainName ? repos.domains.getByDomain(domainName) : undefined;
    if (!domain) throw new NotFound("unknown domain");
    if (!username) throw new BadRequest("username required");
    if (mode !== undefined && mode !== "reserve" && mode !== "mint") throw new BadRequest("mode must be 'reserve' or 'mint'");
    if (mode === "mint") {
      const { address, secret } = addressService.mint(domain, username);
      res.status(201).json({ id: address.id, username: address.username, domain: domain.domain, status: address.status, secret });
    } else {
      const { address, claimCode } = addressService.reserve(domain, username);
      res.status(201).json({ id: address.id, username: address.username, domain: domain.domain, status: address.status, claimCode });
    }
  });
  r.patch("/addresses/:id", (req, res) => {
    const status = (req.body ?? {}).status as AddressStatus | undefined;
    if (status !== "active" && status !== "revoked") throw new BadRequest("status must be active or revoked");
    repos.addresses.updateStatus(Number(req.params.id), status);
    res.json({ ok: true });
  });
  r.patch("/addresses/:id/rails", (req, res) => {
    const id = Number(req.params.id);
    if (!repos.addresses.getById(id)) throw new NotFound("address not found");
    addressService.setRailPolicy(id, (req.body ?? {}).disabledRails);
    const updated = repos.addresses.getById(id)!;
    res.json({
      id: updated.id,
      disabledRails: updated.disabledRails,
      rails: effectiveRails({ arkadeAddress: updated.arkadeAddress, claimPublicKey: updated.claimPublicKey, boardingAddress: updated.boardingAddress, disabledRails: updated.disabledRails }, adminRailCaps(deps)),
    });
  });
  r.delete("/addresses/:id", (req, res) => { repos.addresses.delete(Number(req.params.id)); res.json({ ok: true }); });

  return r;
}
