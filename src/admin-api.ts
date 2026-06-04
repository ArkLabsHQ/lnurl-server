import { Router } from "express";
import type { Repositories } from "./db/repositories/index.js";
import type { AddressService } from "./address-service.js";
import { ProvisioningError } from "./address-service.js";
import type { SessionManager } from "./session-manager.js";
import type { AddressStatus } from "./db/types.js";

export interface AdminDeps {
  repos: Repositories;
  addressService: AddressService;
  sessions: SessionManager;
}

const VALID_ALLOCATION_MODES = new Set(["self", "random", "admin"]);

/** True iff every entry is one of the allowed allocation modes. */
function isValidAllocationModes(x: unknown): boolean {
  return Array.isArray(x) && x.every((m) => typeof m === "string" && VALID_ALLOCATION_MODES.has(m));
}

export function createAdminApi(deps: AdminDeps): Router {
  const { repos, addressService, sessions } = deps;
  const r = Router();

  // ── Domains ───────────────────────────────────────────────
  r.get("/domains", (_req, res) => res.json(repos.domains.list()));
  r.post("/domains", (req, res) => {
    const b = req.body ?? {};
    if (!b.domain || !Array.isArray(b.allocationModes)) { res.status(400).json({ error: "domain and allocationModes are required" }); return; }
    if (!isValidAllocationModes(b.allocationModes)) { res.status(400).json({ error: "allocationModes entries must each be 'self', 'random', or 'admin'" }); return; }
    res.status(201).json(repos.domains.create(b));
  });
  r.patch("/domains/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!repos.domains.getById(id)) { res.status(404).json({ error: "domain not found" }); return; }
    const body = req.body ?? {};
    if (body.allocationModes !== undefined && !isValidAllocationModes(body.allocationModes)) {
      res.status(400).json({ error: "allocationModes entries must each be 'self', 'random', or 'admin'" }); return;
    }
    repos.domains.update(id, body);
    res.json(repos.domains.getById(id));
  });
  r.delete("/domains/:id", (req, res) => { repos.domains.delete(Number(req.params.id)); res.json({ ok: true }); });

  // ── Addresses ─────────────────────────────────────────────
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
      };
    }));
  });
  r.post("/addresses", (req, res) => {
    const { domain: domainName, username, mode } = (req.body ?? {}) as { domain?: string; username?: string; mode?: string };
    const domain = domainName ? repos.domains.getByDomain(domainName) : undefined;
    if (!domain) { res.status(404).json({ error: "unknown domain" }); return; }
    if (!username) { res.status(400).json({ error: "username required" }); return; }
    if (mode !== undefined && mode !== "reserve" && mode !== "mint") { res.status(400).json({ error: "mode must be 'reserve' or 'mint'" }); return; }
    try {
      if (mode === "mint") {
        const { address, secret } = addressService.mint(domain, username);
        res.status(201).json({ id: address.id, username: address.username, domain: domain.domain, status: address.status, secret });
      } else {
        const { address, claimCode } = addressService.reserve(domain, username);
        res.status(201).json({ id: address.id, username: address.username, domain: domain.domain, status: address.status, claimCode });
      }
    } catch (err) {
      if (err instanceof ProvisioningError) { res.status(409).json({ error: err.message, code: err.code }); return; }
      throw err;
    }
  });
  r.patch("/addresses/:id", (req, res) => {
    const status = (req.body ?? {}).status as AddressStatus | undefined;
    if (status !== "active" && status !== "revoked") { res.status(400).json({ error: "status must be active or revoked" }); return; }
    repos.addresses.updateStatus(Number(req.params.id), status);
    res.json({ ok: true });
  });
  r.delete("/addresses/:id", (req, res) => { repos.addresses.delete(Number(req.params.id)); res.json({ ok: true }); });

  // ── API keys ──────────────────────────────────────────────
  r.get("/api-keys", (_req, res) => res.json(repos.apiKeys.list()));
  r.post("/api-keys", (req, res) => {
    const { label, domainId } = (req.body ?? {}) as { label?: string; domainId?: number };
    const { raw, row } = repos.apiKeys.create({ label, domainId: domainId ?? null });
    res.status(201).json({ ...row, key: raw });
  });
  r.delete("/api-keys/:id", (req, res) => { repos.apiKeys.revoke(Number(req.params.id)); res.json({ ok: true }); });

  // ── Blacklist ─────────────────────────────────────────────
  r.get("/blacklist", (req, res) =>
    res.json(req.query.domainId ? repos.blacklist.list(Number(req.query.domainId)) : repos.blacklist.listAll()),
  );
  r.post("/blacklist", (req, res) => {
    const { username, domainId, reason } = (req.body ?? {}) as { username?: string; domainId?: number; reason?: string };
    if (!username) { res.status(400).json({ error: "username required" }); return; }
    res.status(201).json(repos.blacklist.add({ domainId: domainId ?? null, username, reason }));
  });
  r.delete("/blacklist/:id", (req, res) => { repos.blacklist.remove(Number(req.params.id)); res.json({ ok: true }); });

  // ── Live sessions ─────────────────────────────────────────
  r.get("/sessions", (_req, res) => res.json(sessions.activeSessionIds().map((id) => ({ sessionId: id }))));

  return r;
}
