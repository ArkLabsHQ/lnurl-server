import { Router } from "express";
import { createHash } from "node:crypto";
import { encodeLnurl } from "../lnurl.js";
import { isValidToken } from "../usernames.js";
import type { InvoiceResponse } from "../types/index.js";
import { BadRequest, Conflict, NotFound, TooManyRequests, Unauthorized } from "../http-errors.js";
import { bearerToken } from "../http-params.js";
import type { ServerContext } from "../server-context.js";

/** The wallet's side of an interactive session: the SSE stream and its two replies. */
export function lnurlSessionRoutes({ config, sessions, store, settings }: ServerContext): Router {
  const r = Router();

  // Wallet opens an SSE stream. Returns the session ID and LNURL.
  // Accepts optional JSON body { token } for deterministic sessions —
  // the server derives sessionId from the token via SHA-256.
  r.post("/lnurl/session", (req, res) => {
    const { token: providedToken } = req.body ?? {};

    if (providedToken != null && (typeof providedToken !== "string" || !isValidToken(providedToken))) {
      throw new BadRequest("token must be an even-length hex string of at least 32 characters");
    }
    if (!sessions.canAccept(req.ip, config.maxSessions ?? 5_000, config.maxSessionsPerIp ?? 50, providedToken)) {
      throw new TooManyRequests("Session limit reached");
    }

    // Detect an id collision before committing the SSE 200 so we can return a clean 409.
    if (providedToken && sessions.peekCollision(providedToken)) {
      throw new Conflict("Session ID already in use");
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const session = sessions.create(res, providedToken, req.ip);

    if (!session) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: "Session ID already in use" })}\n\n`);
      res.end();
      return;
    }

    const lnurl = encodeLnurl(`${settings.baseUrl()}/lnurl/${session.id}`);
    // Send the LNURL and auth token to the wallet as the first event
    sessions.sendEvent(session.id, {
      type: "session_created",
      data: { sessionId: session.id, lnurl, token: session.token },
    });
  });

  // Wallet posts the bolt11 invoice back, or an error to reject the request.
  r.post("/lnurl/session/:id/invoice", (req, res) => {
    const { id } = req.params;
    const token = bearerToken(req);
    if (!token || !sessions.verifyToken(id, token)) throw new Unauthorized();

    const body = req.body as (InvoiceResponse & { error?: string }) | undefined;

    if (body?.error) {
      if (!sessions.rejectInvoice(id, body.error)) throw new NotFound("No pending invoice request for this session");
      res.json({ ok: true });
      return;
    }

    if (!body?.pr) throw new BadRequest("Missing pr (bolt11 invoice)");
    if (!sessions.resolveInvoice(id, body.pr)) throw new NotFound("No pending invoice request for this session");
    res.json({ ok: true });
  });

  // LUD-21: the wallet reports the preimage once its invoice settles. Authed by the
  // session token; the record is keyed by sha256(preimage), which must match a payment
  // hash this session issued (so a wallet can only settle its own invoices).
  r.post("/lnurl/session/:id/settled", (req, res) => {
    const { id } = req.params;
    const token = bearerToken(req);
    if (!token || !sessions.verifyToken(id, token)) throw new Unauthorized();
    const preimage = (req.body as { preimage?: string } | undefined)?.preimage;
    if (!preimage || !/^[0-9a-f]{64}$/i.test(preimage)) throw new BadRequest("Missing or invalid preimage");
    const hash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
    const rec = store.get(hash);
    if (!rec || rec.sessionId !== id) throw new NotFound("No settlement record for this session");
    store.markSettled(hash, preimage);
    res.json({ ok: true });
  });

  return r;
}
