import { Router } from "express";
import { BadRequest, NotFound } from "../../http-responses.js";
import type { AdminDeps } from "../../admin-context.js";

const VALID_ALLOCATION_MODES = new Set(["self", "random", "admin", "session"]);

const isValidAllocationModes = (x: unknown): boolean =>
  Array.isArray(x) && x.every((m) => typeof m === "string" && VALID_ALLOCATION_MODES.has(m));

export function adminDomainRoutes({ repos }: AdminDeps): Router {
  const r = Router();
  r.get("/domains", (_req, res) => res.json(repos.domains.list()));
  r.post("/domains", (req, res) => {
    const b = req.body ?? {};
    if (!b.domain || !Array.isArray(b.allocationModes)) throw new BadRequest("domain and allocationModes are required");
    if (!isValidAllocationModes(b.allocationModes)) throw new BadRequest("allocationModes entries must each be 'self', 'random', 'admin', or 'session'");
    res.status(201).json(repos.domains.create(b));
  });
  r.patch("/domains/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!repos.domains.getById(id)) throw new NotFound("domain not found");
    const body = req.body ?? {};
    if (body.allocationModes !== undefined && !isValidAllocationModes(body.allocationModes)) {
      throw new BadRequest("allocationModes entries must each be 'self', 'random', 'admin', or 'session'");
    }
    repos.domains.update(id, body);
    res.json(repos.domains.getById(id));
  });
  r.delete("/domains/:id", (req, res) => { repos.domains.delete(Number(req.params.id)); res.json({ ok: true }); });
  return r;
}
