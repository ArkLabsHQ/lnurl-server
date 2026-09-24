import { Router } from "express";
import { RateLimiter } from "../rate-limit.js";
import type { LnurlPayMetadata } from "../types/index.js";
import { LnurlError } from "../http-errors.js";
import { strParam } from "../http-params.js";
import { buildMetadata, requestSessionInvoice } from "../services/pay-flow.js";
import type { ServerContext } from "../server-context.js";
import { attachVerifyBatchRoute, BATCH_PATH } from "../verify-batch.js";

/** LUD-06 pay flow for an interactive session's LNURL, plus LUD-21 verify and LUD-XX verifyBatch. */
export function lnurlPayRoutes({ config, sessions, store, settings, logger }: ServerContext): Router {
  const r = Router();
  // Light per-IP guard for the public verify-polling endpoint.
  const verifyLimiter = new RateLimiter(120, 60_000);

  // LUD-21: the payer polls this to learn whether their invoice settled.
  // Public + unauthed (payment_hash is not secret). Registered before /lnurl/:id.
  r.get("/lnurl/verify/:paymentHash", (req, res) => {
    if (!verifyLimiter.allow(req.ip ?? "unknown")) throw new LnurlError("Too many requests", 429);
    const rec = store.get(req.params.paymentHash.toLowerCase());
    if (!rec) throw new LnurlError("Not found");
    // LUD-XX: non-`pr` options report the destination + a method-specific reference
    // (e.g. a txid, once observed) instead of a preimage/bolt11.
    if (rec.paymentOption !== "lightning") {
      res.json({
        status: "OK",
        settled: rec.settled,
        paymentOption: rec.paymentOption,
        ...(rec.paymentDestination ? { paymentDestination: rec.paymentDestination } : {}),
        // Deliberately not payoutReference: verify is public, and on the covenant
        // rail that txid links the per-payment destination to the user's static
        // address. Owners read it from the authenticated payments sync.
        paymentReference: rec.paymentReference,
        verifyBatch: `${settings.baseUrl()}${BATCH_PATH}`,
      });
      return;
    }
    res.json({ status: "OK", settled: rec.settled, preimage: rec.settled ? rec.preimage : null, pr: rec.pr, verifyBatch: `${settings.baseUrl()}${BATCH_PATH}` });
  });

  // One GET for a whole set of pending invoices, optionally streamed. Before /lnurl/:id,
  // which would otherwise take the literal path.
  attachVerifyBatchRoute(r, { store, verifyLimiter, logger, ...(config.verifyBatch ? { config: config.verifyBatch } : {}) });

  r.get("/lnurl/:id", (req, res) => {
    const { id } = req.params;
    if (!sessions.isActive(id)) throw new LnurlError("This LNURL is no longer active");
    res.json({
      tag: "payRequest",
      callback: `${settings.baseUrl()}/lnurl/${id}/callback`,
      minSendable: settings.minSendable(),
      maxSendable: settings.maxSendable(),
      metadata: buildMetadata(),
      commentAllowed: 140,
    } satisfies LnurlPayMetadata);
  });

  // Requests the bolt11 from the wallet over SSE.
  r.get("/lnurl/:id/callback", async (req, res) => {
    const { id } = req.params;
    const amountStr = strParam(req.query.amount);
    const comment = strParam(req.query.comment);
    if (!amountStr || !Number.isSafeInteger(Number(amountStr))) throw new LnurlError("Missing or invalid amount parameter");
    if (Number(amountStr) <= 0) {
      throw new LnurlError(`Amount must be between ${settings.minSendable()} and ${settings.maxSendable()} millisats`);
    }
    res.json(await requestSessionInvoice({
      sessions, sessionId: id, amountMsat: Number(amountStr), comment,
      min: settings.minSendable(), max: settings.maxSendable(), timeoutMs: settings.invoiceTimeoutMs(),
      offlineReason: "This LNURL is no longer active", store, baseUrl: settings.baseUrl(),
      logger, requestId: res.locals.requestId as string,
    }));
  });

  return r;
}
