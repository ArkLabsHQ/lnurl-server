import { Router } from "express";
import { BadRequest, HttpError, NotFound, NotImplemented } from "../../http-responses.js";
import { RECONCILE_MAX, reconcileAddresses } from "../../reconcile.js";
import type { AdminDeps } from "../../admin-context.js";

/** @see reconcileAddresses */
export function adminReconcileRoutes({ repos, indexer, settlements }: AdminDeps): Router {
  const r = Router();
  const requireIndexer = () => {
    if (!indexer) throw new NotImplemented("reconcile needs an Arkade indexer (ARK_SERVER_URL)");
    return indexer;
  };

  // `?ids=1,2,3`, or every address holding an Arkade identity when omitted — an
  // operator asking "did anything go missing" wants the sweep, not N calls to
  // stitch together. A per-address failure is reported in place rather than
  // failing the batch.
  r.get("/reconcile", async (req, res) => {
    const source = requireIndexer();
    const raw = typeof req.query.ids === "string" ? req.query.ids.trim() : "";
    if (raw) {
      const ids = raw.split(",").map((v) => Number(v.trim()));
      if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new BadRequest("ids must be positive integers");
      if (ids.length > RECONCILE_MAX) throw new BadRequest(`ids accepts at most ${RECONCILE_MAX} addresses`);
      // A missing row has no identity either, so it would otherwise read as one.
      const missing = new Set(ids.filter((id) => !repos.addresses.getById(id)));
      const rows = ids.filter((id) => !missing.has(id)).map((id) => ({ id, arkadeAddress: repos.addresses.getById(id)!.arkadeAddress ?? null }));
      const results = await reconcileAddresses(source, settlements, rows);
      const merged = ids.map((id) => (missing.has(id) ? { addressId: id, error: "address not found" } : results.find((r) => r.addressId === id)!));
      res.json({ addresses: merged, unattributed: merged.reduce((n, r) => n + Number(r.unattributed ?? 0), 0) });
      return;
    }
    const rows = repos.addresses.list({}).filter((a) => a.arkadeAddress).slice(0, RECONCILE_MAX)
      .map((a) => ({ id: a.id, arkadeAddress: a.arkadeAddress ?? null }));
    const results = await reconcileAddresses(source, settlements, rows);
    res.json({ addresses: results, unattributed: results.reduce((n, r) => n + Number(r.unattributed ?? 0), 0) });
  });

  r.get("/addresses/:id/reconcile", async (req, res) => {
    const source = requireIndexer();
    const address = repos.addresses.getById(Number(req.params.id));
    if (!address) throw new NotFound("address not found");
    const [result] = await reconcileAddresses(source, settlements, [{ id: address.id, arkadeAddress: address.arkadeAddress ?? null }]);
    if (result!.error) throw new HttpError(String(result!.error).includes("indexer") ? 502 : 400, String(result!.error));
    res.json(result);
  });

  return r;
}
