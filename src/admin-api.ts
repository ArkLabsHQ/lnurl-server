import { Router } from "express";
import type { Repositories } from "./db/repositories/index.js";
import type { AddressService } from "./address-service.js";
import { ProvisioningError } from "./address-service.js";
import type { SessionManager } from "./session-manager.js";
import type { AddressStatus } from "./db/types.js";
import type { SettingsService } from "./settings.js";
import { isSettingKey, SettingsError } from "./settings.js";
import type { AppConfig } from "./config.js";

export interface AdminDeps {
  repos: Repositories;
  addressService: AddressService;
  sessions: SessionManager;
  settings: SettingsService;
  config: AppConfig;
}

const VALID_ALLOCATION_MODES = new Set(["self", "random", "admin"]);

/** True iff every entry is one of the allowed allocation modes. */
function isValidAllocationModes(x: unknown): boolean {
  return Array.isArray(x) && x.every((m) => typeof m === "string" && VALID_ALLOCATION_MODES.has(m));
}

export function createAdminApi(deps: AdminDeps): Router {
  const { repos, addressService, sessions, settings, config } = deps;
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
  // Live read of the in-memory SessionManager, joined to the addresses table so each
  // connection shows who it belongs to. Never exposes the session token or socket.
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
    if (!sessions.disconnect(req.params.id)) { res.status(404).json({ error: "session not found" }); return; }
    res.json({ ok: true });
  });

  // ── Settings ──────────────────────────────────────────────
  // Editable "soft" settings (env default + DB override) plus a read-only view of the
  // process/secret config that can only change via env + restart.
  r.get("/settings", (_req, res) => res.json({
    editable: settings.view(),
    readOnly: {
      port: config.port,
      adminPort: config.adminPort,
      adminBind: config.adminBind,
      dbPath: config.dbPath ?? null,
      trustProxy: config.trustProxy,
      bootstrapDomain: config.bootstrapDomain ?? null,
      tokenEncryptionKey: config.tokenEncryptionKey ? "set" : config.allowInsecureTokenStorage ? "insecure (plaintext)" : "unset",
    },
  }));
  r.patch("/settings", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      for (const [k, v] of Object.entries(body)) {
        if (!isSettingKey(k)) { res.status(400).json({ error: `unknown setting: ${k}` }); return; }
        settings.set(k, v);
      }
    } catch (e) {
      if (e instanceof SettingsError) { res.status(400).json({ error: e.message }); return; }
      throw e;
    }
    res.json(settings.view());
  });
  r.delete("/settings/:key", (req, res) => {
    if (!isSettingKey(req.params.key)) { res.status(400).json({ error: "unknown setting" }); return; }
    settings.clear(req.params.key);
    res.json(settings.view());
  });

  return r;
}
