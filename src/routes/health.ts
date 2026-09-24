import { Router } from "express";
import type { HealthRegistry } from "../health.js";

export function healthRoutes(health: HealthRegistry): Router {
  const r = Router();
  r.get("/livez", (_req, res) => res.json({ status: "live" }));
  r.get("/readyz", (_req, res) => {
    const snapshot = health.snapshot();
    res.status(snapshot.status === "ready" ? 200 : 503).json(snapshot);
  });
  return r;
}
