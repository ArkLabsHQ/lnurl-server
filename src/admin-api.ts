import { Router } from "express";
import type { Repositories } from "./db/repositories/index.js";
import type { AddressService } from "./address-service.js";
import { ProvisioningError } from "./address-service.js";
import type { SessionManager } from "./session-manager.js";
import type { AddressStatus } from "./db/types.js";
import type { SettingsService } from "./settings.js";
import { isSettingKey, SettingsError } from "./settings.js";
import type { AppConfig } from "./config.js";
import type { SettlementStore } from "./settlement-store.js";
import { adminOpenApiSpec } from "./admin-openapi.js";
import { validateCard } from "@arkade-os/solver-discovery";
import type { DiscoveryService } from "./solver-discovery.js";

const ADMIN_DOCS_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>LNURL Server - Admin API Docs</title>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>body { margin: 0; }</style>
</head>
<body>
  <div id="redoc-container"></div>
  <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
  <script>
    Redoc.init(${JSON.stringify(adminOpenApiSpec)}, {
      scrollYOffset: 0,
      hideDownloadButton: true,
    }, document.getElementById('redoc-container'));
  </script>
</body>
</html>`;

export interface AdminDeps {
  repos: Repositories;
  addressService: AddressService;
  sessions: SessionManager;
  settings: SettingsService;
  config: AppConfig;
  /** Settlement records view (offline swaps, destination payments, relay invoices). */
  settlements?: SettlementStore;
  discovery?: Pick<DiscoveryService, "status" | "refresh">;
}

const VALID_ALLOCATION_MODES = new Set(["self", "random", "admin"]);

/** True iff every entry is one of the allowed allocation modes. */
function isValidAllocationModes(x: unknown): boolean {
  return Array.isArray(x) && x.every((m) => typeof m === "string" && VALID_ALLOCATION_MODES.has(m));
}

export function createAdminApi(deps: AdminDeps): Router {
  const { repos, addressService, sessions, settings, config } = deps;
  const r = Router();

  r.get("/discovery", (_req, res) => {
    if (!deps.discovery) { res.status(503).json({ error: "solver discovery is not configured", code: "discovery_unavailable" }); return; }
    res.json(deps.discovery.status());
  });
  r.post("/discovery/refresh", async (_req, res) => {
    if (!deps.discovery) { res.status(503).json({ error: "solver discovery is not configured", code: "discovery_unavailable" }); return; }
    await deps.discovery.refresh();
    res.json(deps.discovery.status());
  });

  const cardResponse = (row: ReturnType<typeof repos.solverCards.create>) => ({
    ...row,
    card: JSON.parse(row.cardJson),
    cardJson: undefined,
  });
  const refreshDiscovery = async (cardId?: number): Promise<boolean> => {
    if (!deps.discovery) return false;
    try {
      await deps.discovery.refresh();
      const status = deps.discovery.status();
      return cardId === undefined
        ? status.ready
        : status.sources.some((source) => source.source.startsWith(`db:${cardId}:`) && source.ok && source.marketCount > 0);
    }
    catch { return false; }
  };
  const cardInput = (body: unknown): { label: string; network: string; cardJson: string } | { error: string; details?: string[] } => {
    if (!deps.discovery) return { error: "solver discovery is not configured" };
    const b = (body ?? {}) as { label?: unknown; card?: unknown };
    const label = typeof b.label === "string" ? b.label.trim() : "";
    if (!label || label.length > 100) return { error: "label must be 1-100 characters" };
    const checked = validateCard(b.card);
    if (!checked.ok) return { error: "invalid solver card", details: checked.errors };
    const cardJson = JSON.stringify(b.card);
    if (Buffer.byteLength(cardJson) > 128 * 1024) return { error: "solver card exceeds 128 KiB" };
    return { label, network: deps.discovery.status().network, cardJson };
  };

  r.get("/solver-cards", (_req, res) => res.json(repos.solverCards.list().map(cardResponse)));
  r.post("/solver-cards", async (req, res) => {
    const input = cardInput(req.body);
    if ("error" in input) { res.status(400).json({ error: input.error, code: "invalid_solver_card", details: input.details ?? [] }); return; }
    const row = repos.solverCards.create(input);
    const active = await refreshDiscovery(row.id);
    res.status(202).json({ persisted: true, active, card: cardResponse(row) });
  });
  r.put("/solver-cards/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!repos.solverCards.get(id)) { res.status(404).json({ error: "solver card not found" }); return; }
    const input = cardInput(req.body);
    if ("error" in input) { res.status(400).json({ error: input.error, code: "invalid_solver_card", details: input.details ?? [] }); return; }
    const row = repos.solverCards.replace(id, input)!;
    res.status(202).json({ persisted: true, active: await refreshDiscovery(row.id), card: cardResponse(row) });
  });
  r.patch("/solver-cards/:id", async (req, res) => {
    const enabled = (req.body ?? {}).enabled;
    if (typeof enabled !== "boolean") { res.status(400).json({ error: "enabled must be boolean" }); return; }
    const row = repos.solverCards.setEnabled(Number(req.params.id), enabled);
    if (!row) { res.status(404).json({ error: "solver card not found" }); return; }
    const active = await refreshDiscovery(enabled ? row.id : undefined);
    res.status(202).json({ persisted: true, active: enabled && active, card: cardResponse(row) });
  });
  r.delete("/solver-cards/:id", async (req, res) => {
    if (!repos.solverCards.delete(Number(req.params.id))) { res.status(404).json({ error: "solver card not found" }); return; }
    res.status(202).json({ persisted: false, active: await refreshDiscovery() });
  });

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
      tokenEncryptionKey: config.tokenEncryptionKey ? "set" : config.allowInsecureTokenStorage ? "insecure fallback" : "unset",
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

  // ── Settlements ───────────────────────────────────────────
  // Read-only audit view over the settlements table. The preimage is never exposed
  // (a hasPreimage flag is enough for debugging) and `pr` is omitted as bulk.
  r.get("/settlements", (req, res) => {
    if (!deps.settlements) { res.status(503).json({ error: "no settlement store configured" }); return; }
    const limitRaw = Number(req.query.limit);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 200;
    const settled = req.query.settled as string | undefined;
    const option = req.query.option as string | undefined;
    // Filters are pushed into the store query — filtering after the limit would
    // silently truncate (a pending record older than the window must still surface).
    const rows = deps.settlements.listRecent(limit, {
      ...(settled === "true" || settled === "false" ? { settled: settled === "true" } : {}),
      ...(option ? { option } : {}),
    });
    res.json(
      rows.map((x) => ({
        paymentHash: x.paymentHash,
        sessionId: x.sessionId,
        settled: x.settled,
        swapId: x.swapId,
        paymentOption: x.paymentOption,
        paymentDestination: x.paymentDestination,
        paymentReference: x.paymentReference,
        amountMsat: x.amountMsat,
        hasPreimage: x.preimage !== null,
        createdAt: x.createdAt,
        settledAt: x.settledAt,
      })),
    );
  });

  // ── API docs ──────────────────────────────────────────────
  // Served under /admin/api so they sit behind the same auth proxy and don't
  // collide with the SPA's catch-all (which serves index.html for non-/admin/api GETs).
  r.get("/openapi.json", (_req, res) => res.json(adminOpenApiSpec));
  r.get("/docs", (_req, res) => res.type("html").send(ADMIN_DOCS_HTML));

  return r;
}
