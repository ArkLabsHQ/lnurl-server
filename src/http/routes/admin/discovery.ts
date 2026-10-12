import { Router } from "express";
import { validateCard } from "@arkade-os/solver-discovery";
import { describeServerRails } from "../../../rails.js";
import { BadRequest, NotFound, ServiceUnavailable } from "../../errors.js";
import { adminRailCaps, type AdminDeps } from "../../admin-context.js";
import { idParam } from "../../params.js";

/** Rails, solver discovery, and the solver cards discovery reads. */
export function adminDiscoveryRoutes(deps: AdminDeps): Router {
  const { repos, discovery } = deps;
  const r = Router();

  r.get("/rails", (_req, res) => res.json({ rails: describeServerRails(adminRailCaps(deps)) }));

  r.get("/discovery", (_req, res) => {
    if (!discovery) throw new ServiceUnavailable("solver discovery is not configured", { code: "discovery_unavailable" });
    res.json(discovery.status());
  });
  r.post("/discovery/refresh", async (_req, res) => {
    if (!discovery) throw new ServiceUnavailable("solver discovery is not configured", { code: "discovery_unavailable" });
    await discovery.refresh();
    res.json(discovery.status());
  });

  const cardResponse = (row: ReturnType<typeof repos.solverCards.create>) => ({
    ...row,
    card: JSON.parse(row.cardJson),
    cardJson: undefined,
  });
  const refreshDiscovery = async (cardId?: number): Promise<boolean> => {
    if (!discovery) return false;
    try {
      await discovery.refresh();
      const status = discovery.status();
      return cardId === undefined
        ? status.ready
        // Discovery labels DB cards as `db:<numeric id>:<operator label>`.
        // Keep this prefix in sync with DiscoveryService.doRefresh().
        : status.sources.some((source) => source.source.startsWith(`db:${cardId}:`) && source.ok && source.marketCount > 0);
    }
    catch { return false; }
  };
  const cardInput = (body: unknown): { label: string; network: string; cardJson: string } => {
    const invalid = (error: string, details: string[] = []) => new BadRequest(error, { code: "invalid_solver_card", details });
    if (!discovery) throw invalid("solver discovery is not configured");
    const b = (body ?? {}) as { label?: unknown; card?: unknown };
    const label = typeof b.label === "string" ? b.label.trim() : "";
    if (!label || label.length > 100) throw invalid("label must be 1-100 characters");
    const checked = validateCard(b.card);
    if (!checked.ok) throw invalid("invalid solver card", checked.errors);
    const cardJson = JSON.stringify(b.card);
    if (Buffer.byteLength(cardJson) > 128 * 1024) throw invalid("solver card exceeds 128 KiB");
    return { label, network: discovery.status().network, cardJson };
  };

  r.get("/solver-cards", (_req, res) => res.json(repos.solverCards.list().map(cardResponse)));
  r.post("/solver-cards", async (req, res) => {
    const row = repos.solverCards.create(cardInput(req.body));
    const active = await refreshDiscovery(row.id);
    res.status(202).json({ persisted: true, active, card: cardResponse(row) });
  });
  r.put("/solver-cards/:id", async (req, res) => {
    const id = idParam(req.params.id);
    if (!repos.solverCards.get(id)) throw new NotFound("solver card not found");
    const row = repos.solverCards.replace(id, cardInput(req.body))!;
    res.status(202).json({ persisted: true, active: await refreshDiscovery(row.id), card: cardResponse(row) });
  });
  r.patch("/solver-cards/:id", async (req, res) => {
    const enabled = (req.body ?? {}).enabled;
    if (typeof enabled !== "boolean") throw new BadRequest("enabled must be boolean");
    const row = repos.solverCards.setEnabled(idParam(req.params.id), enabled);
    if (!row) throw new NotFound("solver card not found");
    const active = await refreshDiscovery(enabled ? row.id : undefined);
    res.status(202).json({ persisted: true, active: enabled && active, card: cardResponse(row) });
  });
  r.delete("/solver-cards/:id", async (req, res) => {
    if (!repos.solverCards.delete(idParam(req.params.id))) throw new NotFound("solver card not found");
    res.status(202).json({ persisted: false, active: await refreshDiscovery() });
  });

  return r;
}
