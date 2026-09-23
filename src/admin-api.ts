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
import { hex } from "@scure/base";
import { ArkAddress, type IndexerProvider } from "@arkade-os/sdk";
import type { DiscoveryService } from "./solver-discovery.js";
import type { Logger } from "./logger.js";
import type { DurabilityBarrier } from "./enclave/checkpoint.js";
import { describeServerRails, effectiveRails, type ServerRailCaps } from "./rails.js";

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
  /** Arkade indexer, for the post-mortem reconcile. Absent disables that route
   *  rather than failing it, since every other admin read works without one. */
  indexer?: Pick<IndexerProvider, "getVtxos">;
  logger?: Logger;
  durability?: DurabilityBarrier;
}

const VALID_ALLOCATION_MODES = new Set(["self", "random", "admin"]);

/** True iff every entry is one of the allowed allocation modes. */
function isValidAllocationModes(x: unknown): boolean {
  return Array.isArray(x) && x.every((m) => typeof m === "string" && VALID_ALLOCATION_MODES.has(m));
}

export function createAdminApi(deps: AdminDeps): Router {
  const { repos, addressService, sessions, settings, config } = deps;
  const r = Router();

  // Server rail capabilities: what this process wired (the operator view of "it all").
  // Per-address states ride on the addresses list; policy edits go to /addresses/:id/rails.
  const serverCaps = (): ServerRailCaps => {
    const status = deps.discovery?.status();
    return {
      offlineSwapCreator: config.offlineReceive.enabled,
      discoveryReady: status?.ready ?? false,
      ...(status?.reason ? { discoveryReason: status.reason } : {}),
      ...(config.offlineReceive.arkServerUrl ? { arkServerUrl: config.offlineReceive.arkServerUrl } : {}),
      covenantDestinations: config.offlineReceive.covenantDestinations,
    };
  };

  r.get("/rails", (_req, res) => res.json({ rails: describeServerRails(serverCaps()) }));

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
        // Discovery labels DB cards as `db:<numeric id>:<operator label>`.
        // Keep this prefix in sync with DiscoveryService.doRefresh().
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
        disabledRails: a.disabledRails,
        rails: effectiveRails({ arkadeAddress: a.arkadeAddress, claimPublicKey: a.claimPublicKey, boardingAddress: a.boardingAddress, disabledRails: a.disabledRails }, serverCaps()),
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
  r.patch("/addresses/:id/rails", (req, res) => {
    const id = Number(req.params.id);
    if (!repos.addresses.getById(id)) { res.status(404).json({ error: "address not found" }); return; }
    try {
      addressService.setRailPolicy(id, (req.body ?? {}).disabledRails);
    } catch (err) {
      if (err instanceof ProvisioningError) { res.status(400).json({ error: err.message, code: err.code }); return; }
      throw err;
    }
    const updated = repos.addresses.getById(id)!;
    res.json({
      id: updated.id,
      disabledRails: updated.disabledRails,
      rails: effectiveRails({ arkadeAddress: updated.arkadeAddress, claimPublicKey: updated.claimPublicKey, boardingAddress: updated.boardingAddress, disabledRails: updated.disabledRails }, serverCaps()),
    });
  });
  /**
   * Post-mortem: what actually arrived at this address, against what the service
   * recorded. For when a user says they were paid and nothing here shows it.
   *
   * A destination record stops being watched after DESTINATION_WATCH_MS, so a
   * payment arriving later is never attributed: `verify` answers "not found" and
   * the address history stays blank. The money is not lost — a static Arkade
   * address is the user's own, and a covenant destination is still swept to it,
   * because the sweeper reads the contract manager rather than the settlement
   * store. Only the record lapses, and nothing else here can answer "did it land".
   *
   * Read-only by design. Re-attributing a lapsed payment at an address shared by
   * every payment to it would be guesswork; this exists to inform a human.
   */
  /** Scripts per indexer query, matching src/arkade-watcher.ts. Reconciling a
   *  hundred addresses is a sweep, and one read per address would make the
   *  support tool itself the slow part. */
  const RECONCILE_CHUNK = 32;
  const RECONCILE_MAX = 200;

  type ReconcileRow = Record<string, unknown> & { addressId: number };

  /** Shared by the single-address and batch routes so they cannot disagree on
   *  what counts as attributed. */
  async function reconcile(rows: { id: number; arkadeAddress: string | null }[]): Promise<ReconcileRow[]> {
    const out = new Map<number, ReconcileRow>();
    const byScript = new Map<string, { id: number; arkadeAddress: string }[]>();
    for (const row of rows) {
      if (!row.arkadeAddress) {
        out.set(row.id, { addressId: row.id, error: "address has no registered Arkade identity" });
        continue;
      }
      let script: string;
      try {
        script = hex.encode(ArkAddress.decode(row.arkadeAddress).pkScript);
      } catch {
        out.set(row.id, { addressId: row.id, error: "registered Arkade address is undecodable" });
        continue;
      }
      const group = byScript.get(script) ?? [];
      group.push({ id: row.id, arkadeAddress: row.arkadeAddress });
      byScript.set(script, group);
    }

    const scripts = [...byScript.keys()];
    for (let i = 0; i < scripts.length; i += RECONCILE_CHUNK) {
      const chunk = scripts.slice(i, i + RECONCILE_CHUNK);
      let vtxos: { txid: string; vout: number; value: number; createdAt: Date; script: string }[] = [];
      try {
        ({ vtxos } = (await deps.indexer!.getVtxos({ scripts: chunk })) as never);
      } catch (err) {
        // A failed chunk costs its own addresses only; the rest of the sweep stands.
        const message = `indexer lookup failed: ${err instanceof Error ? err.message : String(err)}`;
        for (const script of chunk) for (const a of byScript.get(script)!) out.set(a.id, { addressId: a.id, error: message });
        continue;
      }
      const arrivalsByScript = new Map<string, typeof vtxos>();
      for (const v of vtxos) {
        const bucket = arrivalsByScript.get(v.script) ?? [];
        bucket.push(v);
        arrivalsByScript.set(v.script, bucket);
      }
      for (const script of chunk) {
        // One query may answer several addresses: two users can register the
        // same Arkade address, and then the same arrivals belong to both.
        for (const a of byScript.get(script)!) {
          // Matched on the observed reference, which is what a watcher writes when
          // it attributes an arrival — not on amount, which cannot tell two apart.
          const byReference = new Map(
            (deps.settlements?.listByAddress(a.id, 500) ?? [])
              .filter((r) => r.paymentReference)
              .map((r) => [r.paymentReference!, r]),
          );
          const arrivals = (arrivalsByScript.get(script) ?? []).map((v) => {
            const record = byReference.get(v.txid);
            return {
              txid: v.txid,
              vout: v.vout,
              value: v.value,
              createdAt: v.createdAt instanceof Date ? v.createdAt.toISOString() : v.createdAt,
              attributed: Boolean(record),
              ...(record ? { paymentHash: record.paymentHash } : {}),
            };
          });
          out.set(a.id, {
            addressId: a.id,
            arkadeAddress: a.arkadeAddress,
            script,
            arrivals,
            unattributed: arrivals.filter((x) => !x.attributed).length,
          });
        }
      }
    }
    return rows.map((row) => out.get(row.id) ?? { addressId: row.id, error: "address not found" });
  }

  /**
   * Post-mortem: what actually arrived at these addresses, against what the
   * service recorded. For when a user says they were paid and nothing shows it.
   *
   * A destination record stops being watched after DESTINATION_WATCH_MS, so a
   * payment arriving later is never attributed: `verify` answers "not found" and
   * the address history stays blank. The money is not lost — a static Arkade
   * address is the user's own, and a covenant destination is still swept to it,
   * because the sweeper reads the contract manager rather than the settlement
   * store. Only the record lapses, and nothing else here can answer "did it land".
   *
   * `?ids=1,2,3`, or every address holding an Arkade identity when omitted — an
   * operator asking "did anything go missing" wants the sweep, not N calls to
   * stitch together. A per-address failure is reported in place rather than
   * failing the batch.
   *
   * Read-only by design. Re-attributing a lapsed payment at an address shared by
   * every payment to it would be guesswork; this exists to inform a human.
   */
  r.get("/reconcile", async (req, res) => {
    if (!deps.indexer) { res.status(501).json({ error: "reconcile needs an Arkade indexer (ARK_SERVER_URL)" }); return; }
    const raw = typeof req.query.ids === "string" ? req.query.ids.trim() : "";
    let rows: { id: number; arkadeAddress: string | null }[];
    if (raw) {
      const ids = raw.split(",").map((v) => Number(v.trim()));
      if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) { res.status(400).json({ error: "ids must be positive integers" }); return; }
      if (ids.length > RECONCILE_MAX) { res.status(400).json({ error: `ids accepts at most ${RECONCILE_MAX} addresses` }); return; }
      rows = ids.map((id) => {
        const row = repos.addresses.getById(id);
        return { id, arkadeAddress: row ? row.arkadeAddress ?? null : null, ...(row ? {} : { missing: true }) };
      });
      // A missing row has no identity either, so it would otherwise read as one.
      const missing = new Set(ids.filter((id) => !repos.addresses.getById(id)));
      const results = await reconcile(rows.filter((r) => !missing.has(r.id)));
      const merged = ids.map((id) => (missing.has(id) ? { addressId: id, error: "address not found" } : results.find((r) => r.addressId === id)!));
      res.json({ addresses: merged, unattributed: merged.reduce((n, r) => n + Number(r.unattributed ?? 0), 0) });
      return;
    }
    rows = repos.addresses.list({}).filter((a) => a.arkadeAddress).slice(0, RECONCILE_MAX)
      .map((a) => ({ id: a.id, arkadeAddress: a.arkadeAddress ?? null }));
    const results = await reconcile(rows);
    res.json({ addresses: results, unattributed: results.reduce((n, r) => n + Number(r.unattributed ?? 0), 0) });
  });

  /** The single-address view of the same check. @see GET /reconcile */
  r.get("/addresses/:id/reconcile", async (req, res) => {
    if (!deps.indexer) { res.status(501).json({ error: "reconcile needs an Arkade indexer (ARK_SERVER_URL)" }); return; }
    const address = repos.addresses.getById(Number(req.params.id));
    if (!address) { res.status(404).json({ error: "address not found" }); return; }
    const [result] = await reconcile([{ id: address.id, arkadeAddress: address.arkadeAddress ?? null }]);
    if (result!.error) { res.status(String(result!.error).includes("indexer") ? 502 : 400).json({ error: result!.error }); return; }
    res.json(result);
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
    // Scoped to one address when asked: the store filters by address id, so a
    // link from the Addresses view lands on that address's payments rather than
    // a page the operator has to scan.
    const addressIdRaw = Number(req.query.addressId);
    const addressId = Number.isInteger(addressIdRaw) && addressIdRaw > 0 ? addressIdRaw : undefined;
    const rows = addressId !== undefined
      ? deps.settlements.listByAddress(addressId, limit)
          .filter((x) => (settled === undefined ? true : x.settled === (settled === "true")))
          .filter((x) => (option ? x.paymentOption === option : true))
      : deps.settlements.listRecent(limit, {
          ...(settled === "true" || settled === "false" ? { settled: settled === "true" } : {}),
          ...(option ? { option } : {}),
        });
    // Resolved per page rather than joined in the store: the rows are already
    // capped at `limit`, and an address can be revoked out from under a record
    // whose id survives it.
    const addressFor = (id: number | null): { id: number; lightningAddress: string } | null => {
      if (id === null) return null;
      const row = repos.addresses.getById(id);
      if (!row) return null;
      const domain = repos.domains.getById(row.domainId)?.domain;
      return { id, lightningAddress: domain ? `${row.username}@${domain}` : row.username };
    };
    res.json(
      rows.map((x) => ({
        paymentHash: x.paymentHash,
        sessionId: x.sessionId,
        address: addressFor(x.addressId),
        settled: x.settled,
        swapId: x.swapId,
        paymentOption: x.paymentOption,
        paymentDestination: x.paymentDestination,
        paymentReference: x.paymentReference,
        payoutReference: x.payoutReference,
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
