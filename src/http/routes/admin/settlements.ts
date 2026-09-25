import { Router } from "express";
import { ServiceUnavailable } from "../../errors.js";
import type { AdminDeps } from "../../admin-context.js";

/** Read-only audit view over the settlements table. The preimage is never exposed
 *  (a hasPreimage flag is enough for debugging) and `pr` is omitted as bulk. */
export function adminSettlementRoutes({ repos, settlements }: AdminDeps): Router {
  const r = Router();
  r.get("/settlements", (req, res) => {
    if (!settlements) throw new ServiceUnavailable("no settlement store configured");
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
      ? settlements.listByAddress(addressId, limit)
          .filter((x) => (settled === undefined ? true : x.settled === (settled === "true")))
          .filter((x) => (option ? x.paymentOption === option : true))
      : settlements.listRecent(limit, {
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
  return r;
}
