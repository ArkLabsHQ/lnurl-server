import express from "express";
import cors from "cors";
import { bech32 } from "@scure/base";
import { SessionManager } from "./session-manager.js";
import type {
  LnurlServiceConfig,
  LnurlPayMetadata,
  LnurlPayCallbackResponse,
  LnurlErrorResponse,
  InvoiceResponse,
} from "./types.js";

const DEFAULT_INVOICE_TIMEOUT_MS = 30_000;
const METADATA_DESCRIPTION = "Arkade LNURL Receive";

function encodeLnurl(url: string): string {
  const words = bech32.toWords(new TextEncoder().encode(url));
  return bech32.encode("lnurl", words, 1023).toUpperCase();
}

function buildMetadata(): string {
  return JSON.stringify([["text/plain", METADATA_DESCRIPTION]]);
}

export function createServer(config: LnurlServiceConfig): express.Express {
  const app = express();
  const sessions = new SessionManager();
  const invoiceTimeout =
    config.invoiceTimeoutMs ?? DEFAULT_INVOICE_TIMEOUT_MS;

  app.use(cors());
  app.use(express.json());

  // ─── POST /lnurl/session ─────────────────────────────────────────────
  // Wallet opens an SSE stream. Returns the session ID and LNURL.
  app.post("/lnurl/session", (_req, res) => {
    // Set SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const session = sessions.create(res);

    const callbackUrl = `${config.baseUrl}/lnurl/${session.id}`;
    const lnurl = encodeLnurl(callbackUrl);

    // Send the LNURL and auth token to the wallet as the first event
    sessions.sendEvent(session.id, {
      type: "session_created",
      data: { sessionId: session.id, lnurl, token: session.token },
    });
  });

  // ─── GET /lnurl/:id ──────────────────────────────────────────────────
  // LNURL-pay first call (LUD-06). Returns pay metadata.
  app.get("/lnurl/:id", (req, res) => {
    const { id } = req.params;

    if (!sessions.isActive(id)) {
      const err: LnurlErrorResponse = {
        status: "ERROR",
        reason: "This LNURL is no longer active",
      };
      res.json(err);
      return;
    }

    const response: LnurlPayMetadata = {
      tag: "payRequest",
      callback: `${config.baseUrl}/lnurl/${id}/callback`,
      minSendable: config.minSendable,
      maxSendable: config.maxSendable,
      metadata: buildMetadata(),
      commentAllowed: 140,
    };

    res.json(response);
  });

  // ─── GET /lnurl/:id/callback?amount=<msat> ──────────────────────────
  // LNURL-pay callback (LUD-06). Requests bolt11 from wallet via SSE.
  app.get("/lnurl/:id/callback", async (req, res) => {
    const { id } = req.params;
    const amountStr = req.query.amount as string | undefined;
    const comment = req.query.comment as string | undefined;

    if (!amountStr || isNaN(Number(amountStr))) {
      const err: LnurlErrorResponse = {
        status: "ERROR",
        reason: "Missing or invalid amount parameter",
      };
      res.json(err);
      return;
    }

    const amountMsat = Number(amountStr);

    if (amountMsat < config.minSendable || amountMsat > config.maxSendable) {
      const err: LnurlErrorResponse = {
        status: "ERROR",
        reason: `Amount must be between ${config.minSendable} and ${config.maxSendable} millisats`,
      };
      res.json(err);
      return;
    }

    if (!sessions.isActive(id)) {
      const err: LnurlErrorResponse = {
        status: "ERROR",
        reason: "This LNURL is no longer active",
      };
      res.json(err);
      return;
    }

    try {
      const pr = await sessions.requestInvoice(
        id,
        amountMsat,
        comment,
        invoiceTimeout,
      );

      const response: LnurlPayCallbackResponse = { pr, routes: [] };
      res.json(response);
    } catch (err) {
      const errorResponse: LnurlErrorResponse = {
        status: "ERROR",
        reason: err instanceof Error ? err.message : "Failed to get invoice",
      };
      res.json(errorResponse);
    }
  });

  // ─── POST /lnurl/session/:id/invoice ─────────────────────────────────
  // Wallet posts the bolt11 invoice back, or an error to reject the request.
  // Requires Authorization: Bearer <token> from session_created event.
  app.post("/lnurl/session/:id/invoice", (req, res) => {
    const { id } = req.params;
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";

    if (!token || !sessions.verifyToken(id, token)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const body = req.body as (InvoiceResponse & { error?: string }) | undefined;

    // Wallet is rejecting the invoice request
    if (body?.error) {
      const rejected = sessions.rejectInvoice(id, body.error);
      if (!rejected) {
        res.status(404).json({ error: "No pending invoice request for this session" });
        return;
      }
      res.json({ ok: true });
      return;
    }

    if (!body?.pr) {
      res.status(400).json({ error: "Missing pr (bolt11 invoice)" });
      return;
    }

    const resolved = sessions.resolveInvoice(id, body.pr);

    if (!resolved) {
      res.status(404).json({ error: "No pending invoice request for this session" });
      return;
    }

    res.json({ ok: true });
  });

  return app;
}
