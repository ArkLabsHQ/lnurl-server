import express from "express";
import cors from "cors";
import { randomBytes } from "node:crypto";
import { SessionManager } from "./session-manager.js";
import { openApiSpec } from "./openapi.js";
import type { Repositories } from "./db/repositories/index.js";
import { originFromRequest, domainFromHost } from "./http-origin.js";
import { encodeLnurl } from "./lnurl.js";
import type { AddressService } from "./address-service.js";
import { ProvisioningError } from "./address-service.js";
import type { RateLimiter } from "./rate-limit.js";
import type {
  LnurlServiceConfig,
  LnurlPayMetadata,
  LnurlPayCallbackResponse,
  LnurlErrorResponse,
  InvoiceResponse,
} from "./types.js";

const DEFAULT_INVOICE_TIMEOUT_MS = 30_000;
const METADATA_DESCRIPTION = "Arkade LNURL Receive";

const PROVISIONING_STATUS: Record<string, number> = {
  invalid_token: 400, invalid_username: 400, forbidden_mode: 403,
  blacklisted: 409, taken: 409, limit_reached: 429, invalid_claim: 401,
};

export interface ServerDeps {
  repos: Repositories;
  addressService?: AddressService;
  registrationLimiter?: RateLimiter;
  sessions?: SessionManager;
}

function buildMetadata(identifier?: string): string {
  const entries: [string, string][] = [["text/plain", METADATA_DESCRIPTION]];
  if (identifier) entries.push(["text/identifier", identifier]);
  return JSON.stringify(entries);
}

// Shared core: validate amount range, ensure session online, request bolt11, respond.
async function requestInvoiceAndRespond(args: {
  sessions: SessionManager;
  sessionId: string;
  amountMsat: number;
  comment: string | undefined;
  min: number;
  max: number;
  timeoutMs: number;
  offlineReason: string;
  res: express.Response;
}): Promise<void> {
  const { sessions, sessionId, amountMsat, comment, min, max, timeoutMs, offlineReason, res } = args;
  if (amountMsat < min || amountMsat > max) {
    res.json({ status: "ERROR", reason: `Amount must be between ${min} and ${max} millisats` } satisfies LnurlErrorResponse);
    return;
  }
  if (!sessions.isActive(sessionId)) {
    res.json({ status: "ERROR", reason: offlineReason } satisfies LnurlErrorResponse);
    return;
  }
  try {
    const pr = await sessions.requestInvoice(sessionId, amountMsat, comment, timeoutMs);
    res.json({ pr, routes: [] } satisfies LnurlPayCallbackResponse);
  } catch (err) {
    res.json({ status: "ERROR", reason: err instanceof Error ? err.message : "Failed to get invoice" } satisfies LnurlErrorResponse);
  }
}

export function createServer(config: LnurlServiceConfig, deps?: ServerDeps): express.Express {
  const app = express();
  const sessions = deps?.sessions ?? new SessionManager();
  const invoiceTimeout =
    config.invoiceTimeoutMs ?? DEFAULT_INVOICE_TIMEOUT_MS;

  // Default: trust exactly one proxy hop so req.ip reflects the real client IP behind
  // a single LB/CDN. Set trustProxy to a higher number for deeper proxy stacks, or false
  // to disable entirely (direct connections only).
  app.set("trust proxy", config.trustProxy ?? 1);

  app.use(
    cors({
      origin: true,
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
  );
  app.use(express.json());

  // ─── GET / ─────────────────────────────────────────────────────────
  // Serves Redocly API docs as the home page.
  app.get("/", (_req, res) => {
    res.send(`<!DOCTYPE html>
<html>
<head>
  <title>LNURL Server - API Docs</title>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>body { margin: 0; }</style>
</head>
<body>
  <div id="redoc-container"></div>
  <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
  <script>
    Redoc.init(${JSON.stringify(openApiSpec)}, {
      scrollYOffset: 0,
      hideDownloadButton: true,
    }, document.getElementById('redoc-container'));
  </script>
</body>
</html>`);
  });

  // ─── GET /openapi.json ────────────────────────────────────────────
  app.get("/openapi.json", (_req, res) => {
    res.json(openApiSpec);
  });

  // ─── POST /lnurl/session ─────────────────────────────────────────────
  // Wallet opens an SSE stream. Returns the session ID and LNURL.
  // Accepts optional JSON body { token } for deterministic sessions —
  // the server derives sessionId from the token via SHA-256.
  app.post("/lnurl/session", (req, res) => {
    const { token: providedToken } = req.body ?? {};

    const HEX_RE = /^[0-9a-f]+$/i;
    if (providedToken != null && (typeof providedToken !== "string" || providedToken.length < 32 || !HEX_RE.test(providedToken))) {
      res.status(400).json({ error: "token must be a hex string of at least 32 characters" });
      return;
    }

    // Set SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const session = sessions.create(res, providedToken);

    if (!session) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: "Session ID already in use" })}\n\n`);
      res.end();
      return;
    }

    const callbackUrl = `${config.baseUrl}/lnurl/${session.id}`;
    const lnurl = encodeLnurl(callbackUrl);

    // Send the LNURL and auth token to the wallet as the first event
    sessions.sendEvent(session.id, {
      type: "session_created",
      data: { sessionId: session.id, lnurl, token: session.token },
    });
  });

  // ─── GET /lnurl/address ──────────────────────────────────────────────
  // List addresses by token. Must be registered before /lnurl/:id to avoid
  // "address" being captured as a session id param.
  app.get("/lnurl/address", (req, res) => {
    const addressService = deps?.addressService;
    if (!addressService) { res.status(404).json({ error: "Not found" }); return; }
    const auth = req.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) { res.status(401).json({ error: "Unauthorized" }); return; }
    const origin = originFromRequest(req);
    const list = addressService.listByToken(token).map((a) => {
      const domain = deps!.repos.domains.getById(a.domainId)!;
      return {
        username: a.username, domain: domain.domain, status: a.status, createdAt: a.createdAt,
        lightningAddress: `${a.username}@${domain.domain}`,
        lnurl: encodeLnurl(`${origin}/.well-known/lnurlp/${a.username}`),
      };
    });
    res.json(list);
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
      res.json({ status: "ERROR", reason: "Missing or invalid amount parameter" } satisfies LnurlErrorResponse);
      return;
    }
    await requestInvoiceAndRespond({
      sessions, sessionId: id, amountMsat: Number(amountStr), comment,
      min: config.minSendable, max: config.maxSendable, timeoutMs: invoiceTimeout,
      offlineReason: "This LNURL is no longer active", res,
    });
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

  // ─── LUD-16 routes (only when deps / DB are provided) ───────────────
  if (deps?.repos) {
    const { repos } = deps;

    app.get("/.well-known/lnurlp/:username", (req, res) => {
      const domainName = domainFromHost(req.get("host") ?? undefined);
      const domain = domainName ? repos.domains.getByDomain(domainName) : undefined;
      if (!domain || !domain.enabled) {
        res.json({ status: "ERROR", reason: "Unknown or disabled domain" } satisfies LnurlErrorResponse);
        return;
      }
      const username = req.params.username.toLowerCase();
      const address = repos.addresses.getByDomainAndUsername(domain.id, username);
      if (!address || address.status !== "active") {
        res.json({ status: "ERROR", reason: "Unknown LN address" } satisfies LnurlErrorResponse);
        return;
      }
      const origin = originFromRequest(req);
      const response: LnurlPayMetadata = {
        tag: "payRequest",
        callback: `${origin}/.well-known/lnurlp/${username}/callback`,
        minSendable: domain.minSendable ?? config.minSendable,
        maxSendable: domain.maxSendable ?? config.maxSendable,
        metadata: buildMetadata(`${username}@${domain.domain}`),
        commentAllowed: 140,
      };
      res.json(response);
    });

    app.get("/.well-known/lnurlp/:username/callback", async (req, res) => {
      const domainName = domainFromHost(req.get("host") ?? undefined);
      const domain = domainName ? repos.domains.getByDomain(domainName) : undefined;
      if (!domain || !domain.enabled) {
        res.json({ status: "ERROR", reason: "Unknown or disabled domain" } satisfies LnurlErrorResponse);
        return;
      }
      const username = req.params.username.toLowerCase();
      const address = repos.addresses.getByDomainAndUsername(domain.id, username);
      if (!address || address.status !== "active" || !address.sessionId) {
        res.json({ status: "ERROR", reason: "Unknown LN address" } satisfies LnurlErrorResponse);
        return;
      }
      const amountStr = req.query.amount as string | undefined;
      const comment = req.query.comment as string | undefined;
      if (!amountStr || isNaN(Number(amountStr))) {
        res.json({ status: "ERROR", reason: "Missing or invalid amount parameter" } satisfies LnurlErrorResponse);
        return;
      }
      await requestInvoiceAndRespond({
        sessions, sessionId: address.sessionId, amountMsat: Number(amountStr), comment,
        min: domain.minSendable ?? config.minSendable, max: domain.maxSendable ?? config.maxSendable,
        timeoutMs: invoiceTimeout, offlineReason: `${username}@${domain.domain} is currently offline`, res,
      });
    });

    // ─── POST /lnurl/session/:id/withdraw ────────────────────────────────
    // Funding wallet creates a withdraw link (auth: Bearer token).
    app.post("/lnurl/session/:id/withdraw", (req, res) => {
      const { id } = req.params;
      const auth = req.headers.authorization;
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!token || !sessions.verifyToken(id, token)) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { minWithdrawable, maxWithdrawable, description, usesRemaining, expiresAt } = (req.body ?? {}) as Record<string, unknown>;
      const min = Number(minWithdrawable), max = Number(maxWithdrawable);
      if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min) {
        res.status(400).json({ error: "minWithdrawable and maxWithdrawable must be positive with min <= max" });
        return;
      }
      const uses = usesRemaining === undefined ? 1 : Number(usesRemaining);
      if (!Number.isInteger(uses) || uses < 1) {
        res.status(400).json({ error: "usesRemaining must be an integer >= 1" });
        return;
      }
      if (expiresAt !== undefined && expiresAt !== null) {
        const exp = Number(expiresAt);
        if (!Number.isFinite(exp) || exp <= Date.now()) {
          res.status(400).json({ error: "expiresAt must be a finite timestamp strictly in the future" });
          return;
        }
      }
      const withdrawId = randomBytes(32).toString("hex");
      repos.withdrawals.create({
        id: withdrawId, sessionId: id, minWithdrawable: min, maxWithdrawable: max,
        description: typeof description === "string" ? description : undefined,
        usesRemaining: uses,
        expiresAt: expiresAt !== undefined && expiresAt !== null ? Number(expiresAt) : null,
      });
      const lnurl = encodeLnurl(`${originFromRequest(req)}/lnurl/withdraw/${withdrawId}`);
      res.status(201).json({ withdrawId, lnurl });
    });

    // ─── GET /lnurl/withdraw/:id ─────────────────────────────────────────
    // LUD-03 first request — returns withdrawRequest metadata.
    app.get("/lnurl/withdraw/:id", (req, res) => {
      const w = repos.withdrawals.get(req.params.id);
      if (!w || w.status !== "active") { res.json({ status: "ERROR", reason: "This withdraw link is no longer active" } satisfies LnurlErrorResponse); return; }
      if (w.expiresAt != null && Date.now() > w.expiresAt) { repos.withdrawals.markExpired(w.id); res.json({ status: "ERROR", reason: "This withdraw link has expired" } satisfies LnurlErrorResponse); return; }
      res.json({
        tag: "withdrawRequest",
        callback: `${originFromRequest(req)}/lnurl/withdraw/${w.id}/callback`,
        k1: w.id,
        defaultDescription: w.description ?? "Withdraw",
        minWithdrawable: w.minWithdrawable,
        maxWithdrawable: w.maxWithdrawable,
      });
    });

    // ─── GET /lnurl/withdraw/:id/callback?k1=&pr= ────────────────────────
    // Withdrawer supplies bolt11; relay to funding wallet via SSE and wait.
    app.get("/lnurl/withdraw/:id/callback", async (req, res) => {
      const w = repos.withdrawals.get(req.params.id);
      const k1 = req.query.k1 as string | undefined;
      const pr = req.query.pr as string | undefined;
      if (!w || w.status !== "active") { res.json({ status: "ERROR", reason: "This withdraw link is no longer active" } satisfies LnurlErrorResponse); return; }
      if (w.expiresAt != null && Date.now() > w.expiresAt) { repos.withdrawals.markExpired(w.id); res.json({ status: "ERROR", reason: "This withdraw link has expired" } satisfies LnurlErrorResponse); return; }
      if (k1 !== w.id || !pr) { res.json({ status: "ERROR", reason: "Missing or invalid k1/pr" } satisfies LnurlErrorResponse); return; }
      if (!sessions.isActive(w.sessionId)) { res.json({ status: "ERROR", reason: "The funding wallet is currently offline" } satisfies LnurlErrorResponse); return; }

      try {
        await sessions.requestWithdraw(
          w.sessionId,
          { withdrawId: w.id, bolt11: pr, minWithdrawable: w.minWithdrawable, maxWithdrawable: w.maxWithdrawable, description: w.description ?? undefined },
          invoiceTimeout,
        );
        repos.withdrawals.markUsed(w.id);
        res.json({ status: "OK" });
      } catch (err) {
        res.json({ status: "ERROR", reason: err instanceof Error ? err.message : "Withdraw failed" } satisfies LnurlErrorResponse);
      }
    });

    // ─── POST /lnurl/session/:id/withdraw/:wid ───────────────────────────
    // Funding wallet reports payout result (auth: Bearer token).
    app.post("/lnurl/session/:id/withdraw/:wid", (req, res) => {
      const { id, wid } = req.params;
      const auth = req.headers.authorization;
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!token || !sessions.verifyToken(id, token)) { res.status(401).json({ error: "Unauthorized" }); return; }

      const body = (req.body ?? {}) as { status?: string; error?: string };
      const handled = body.error
        ? sessions.rejectWithdraw(id, wid, body.error)
        : sessions.resolveWithdraw(id, wid);
      if (!handled) { res.status(404).json({ error: "No pending withdraw for this session/id" }); return; }
      res.json({ ok: true });
    });

    const addressService = deps.addressService;
    if (addressService) {
      const limiter = deps.registrationLimiter;

      app.post("/lnurl/address", (req, res) => {
        const domainName = domainFromHost((req.body?.domain as string | undefined) ?? req.get("host") ?? undefined);
        const domain = domainName ? deps.repos.domains.getByDomain(domainName) : undefined;
        if (!domain || !domain.enabled) { res.status(404).json({ error: "Unknown or disabled domain" }); return; }

        // Rate-limit keys on req.ip — only trustworthy when `trust proxy` matches the
        // actual proxy hop count (see app.set("trust proxy", ...) above).
        if (limiter && !limiter.allow(req.ip ?? "unknown")) { res.status(429).json({ error: "Too many requests" }); return; }

        if (domain.requireApiKey) {
          const key = req.get("x-api-key");
          if (!key || !deps.repos.apiKeys.verify(key, domain.id)) { res.status(401).json({ error: "Valid X-API-Key required" }); return; }
        }

        const { token, username, claimCode } = (req.body ?? {}) as { token?: string; username?: string; claimCode?: string };
        if (!token) { res.status(400).json({ error: "Missing token" }); return; }

        try {
          const { address, lightningAddress } = addressService.register({ domain, username, token, claimCode });
          const lnurl = encodeLnurl(`${originFromRequest(req)}/.well-known/lnurlp/${address.username}`);
          res.status(201).json({ lightningAddress, lnurl, username: address.username, domain: domain.domain, status: address.status });
        } catch (err) {
          if (err instanceof ProvisioningError) { res.status(PROVISIONING_STATUS[err.code] ?? 400).json({ error: err.message, code: err.code }); return; }
          throw err;
        }
      });

      app.delete("/lnurl/address/:username", (req, res) => {
        const domainName = domainFromHost((req.query.domain as string | undefined) ?? req.get("host") ?? undefined);
        const domain = domainName ? deps.repos.domains.getByDomain(domainName) : undefined;
        if (!domain) { res.status(404).json({ error: "Unknown domain" }); return; }
        const auth = req.headers.authorization;
        const token = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
        if (!token) { res.status(401).json({ error: "Unauthorized" }); return; }
        const ok = addressService.revokeOwn(domain, req.params.username, token);
        if (!ok) { res.status(404).json({ error: "Address not found or not owned by this token" }); return; }
        res.json({ ok: true });
      });
    }
  }

  return app;
}
