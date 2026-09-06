import express from "express";
import cors from "cors";
import { createHash, randomBytes } from "node:crypto";
import { SessionManager } from "./session-manager.js";
import { openApiSpec } from "./openapi.js";
import type { Repositories } from "./db/repositories/index.js";
import { domainFromHost } from "./http-origin.js";
import { encodeLnurl } from "./lnurl.js";
import type { AddressService } from "./address-service.js";
import { ProvisioningError } from "./address-service.js";
import { RateLimiter } from "./rate-limit.js";
import { paymentHashFromBolt11 } from "./bolt11.js";
import { MemorySettlementStore, type SettlementStore } from "./settlement-store.js";
import type { OfflineSwapCreator } from "./intent-swap.js";
import { ArkAddress } from "@arkade-os/sdk";
import { advertisedOptions, resolvePaymentOption } from "./payment-options.js";
import { applyQuote, type QuoteProvider, type PaymentQuote } from "./quote-provider.js";
import { staticSettings, type RuntimeSettings } from "./settings.js";
import type {
  LnurlServiceConfig,
  LnurlPayMetadata,
  LnurlPayCallbackResponse,
  LnurlPayDestinationResponse,
  LnurlErrorResponse,
  InvoiceResponse,
} from "./types.js";

const DEFAULT_INVOICE_TIMEOUT_MS = 30_000;
const METADATA_DESCRIPTION = "Arkade LNURL Receive";

const PROVISIONING_STATUS: Record<string, number> = {
  invalid_token: 400, invalid_username: 400, forbidden_mode: 403,
  blacklisted: 409, taken: 409, limit_reached: 429, invalid_claim: 401,
};

/** Express types query values as string | string[] | ...; an array (`?a=1&a=2`)
 *  is never meaningful for our params — take them only when they're a string. */
const strParam = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export interface ServerDeps {
  repos: Repositories;
  addressService?: AddressService;
  registrationLimiter?: RateLimiter;
  sessions?: SessionManager;
  settings?: RuntimeSettings;
  settlements?: SettlementStore;
  /** When set, an offline LN address with a registered Arkade identity gets a
   *  server-orchestrated corridor swap instead of an "offline" error. */
  offlineSwapCreator?: OfflineSwapCreator;
  /** When set, enables LUD-XX unit-denominated quotes (advertises `units`, quotes callbacks). */
  quoteProvider?: QuoteProvider;
}

// Create a solver-mediated receive swap for an offline receiver and return the hold
// invoice + a LUD-21 verify URL. The preimage is held in the store (unrevealed until
// the settlement poller flips it) keyed by the swap's payment hash. It is safe at
// rest because the covenant's `enforcePayTo` pins the claim to the user's address —
// learning the preimage cannot redirect funds.
async function createOfflineSwapAndRespond(args: {
  creator: OfflineSwapCreator;
  store: SettlementStore;
  baseUrl: string;
  amountMsat: number;
  receiveAddress: string;
  claimPublicKey: string;
  addressId: number;
  paymentQuote?: PaymentQuote;
  res: express.Response;
}): Promise<void> {
  const { creator, store, baseUrl, amountMsat, receiveAddress, claimPublicKey, addressId, paymentQuote, res } = args;
  try {
    // Caller guarantees whole satoshis (rejected at the route otherwise).
    const swap = await creator.create({ amountSat: amountMsat / 1000, receiveAddress, claimPublicKey });
    store.create({
      paymentHash: swap.preimageHash,
      pr: swap.invoice,
      sessionId: `offline:${addressId}`,
      preimage: swap.preimage,
      swapId: swap.swapId,
      amountMsat,
    });
    res.json({
      pr: swap.invoice,
      routes: [],
      verify: `${baseUrl}/lnurl/verify/${swap.preimageHash}`,
      ...(paymentQuote ? { paymentQuote } : {}),
    } satisfies LnurlPayCallbackResponse);
  } catch (err) {
    res.json({ status: "ERROR", reason: err instanceof Error ? err.message : "Failed to create swap" } satisfies LnurlErrorResponse);
  }
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
  store: SettlementStore;
  baseUrl: string;
  paymentQuote?: PaymentQuote;
  res: express.Response;
}): Promise<void> {
  const { sessions, sessionId, amountMsat, comment, min, max, timeoutMs, offlineReason, store, baseUrl, paymentQuote, res } = args;
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
    // LUD-21: record the invoice and hand the payer a verify URL. If the bolt11 can't be
    // decoded we can't key a record, so we omit verify but still return the pr.
    const paymentHash = paymentHashFromBolt11(pr);
    if (paymentHash) {
      store.create({ paymentHash, pr, sessionId, amountMsat });
      res.json({ pr, routes: [], verify: `${baseUrl}/lnurl/verify/${paymentHash}`, ...(paymentQuote ? { paymentQuote } : {}) } satisfies LnurlPayCallbackResponse);
    } else {
      res.json({ pr, routes: [], ...(paymentQuote ? { paymentQuote } : {}) } satisfies LnurlPayCallbackResponse);
    }
  } catch (err) {
    res.json({ status: "ERROR", reason: err instanceof Error ? err.message : "Failed to get invoice" } satisfies LnurlErrorResponse);
  }
}

export function createServer(config: LnurlServiceConfig, deps?: ServerDeps): express.Express {
  const app = express();
  const sessions = deps?.sessions ?? new SessionManager();
  // LUD-21 settlement records. DB-backed when provided, else in-memory with TTL.
  const store: SettlementStore = deps?.settlements ?? new MemorySettlementStore(config.verifyTtlMs ?? 86_400_000);
  // Light per-IP guard for the public verify-polling endpoint.
  const verifyLimiter = new RateLimiter(120, 60_000);
  // Tighter per-IP guard on callback branches that cost resources without a live
  // wallet session: each offline-swap hit asks the solver for a fresh quote, and
  // each destination hit writes a store record.
  const addressCallbackLimiter = new RateLimiter(30, 60_000);
  // When configured, offline LN addresses receive via a solver-mediated corridor swap.
  const creator = deps?.offlineSwapCreator;
  // When configured, enables LUD-XX unit-denominated quotes.
  const quoteProvider = deps?.quoteProvider;
  // Soft settings are read per-request so DB-backed overrides take effect without a restart.
  // No DB (library/in-memory mode) → fall back to the static config values.
  const settings: RuntimeSettings = deps?.settings ?? staticSettings({
    minSendable: config.minSendable,
    maxSendable: config.maxSendable,
    invoiceTimeoutMs: config.invoiceTimeoutMs ?? DEFAULT_INVOICE_TIMEOUT_MS,
    baseUrl: config.baseUrl,
    registrationRateLimitPerMin: 10,
  });

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

    // Detect an id collision before committing the SSE 200 so we can return a clean 409.
    if (providedToken && sessions.peekCollision(providedToken)) {
      res.status(409).json({ error: "Session ID already in use" });
      return;
    }

    // Set SSE headers
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

    const callbackUrl = `${settings.baseUrl()}/lnurl/${session.id}`;
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
    const list = addressService.listByToken(token).map((a) => {
      const domain = deps!.repos.domains.getById(a.domainId)!;
      return {
        username: a.username, domain: domain.domain, status: a.status, createdAt: a.createdAt,
        lightningAddress: `${a.username}@${domain.domain}`,
        // Build from the address's own domain (scheme from the trusted proxy), never the raw Host header.
        lnurl: encodeLnurl(`${req.protocol}://${domain.domain}/.well-known/lnurlp/${a.username}`),
      };
    });
    res.json(list);
  });

  // ─── GET /lnurl/verify/:paymentHash ──────────────────────────────────
  // LUD-21: the payer polls this to learn whether their invoice settled.
  // Public + unauthed (payment_hash is not secret). Registered before /lnurl/:id.
  app.get("/lnurl/verify/:paymentHash", (req, res) => {
    if (!verifyLimiter.allow(req.ip ?? "unknown")) {
      res.status(429).json({ status: "ERROR", reason: "Too many requests" } satisfies LnurlErrorResponse);
      return;
    }
    const rec = store.get(req.params.paymentHash.toLowerCase());
    if (!rec) {
      res.json({ status: "ERROR", reason: "Not found" } satisfies LnurlErrorResponse);
      return;
    }
    // LUD-XX: non-`pr` options report the destination + a method-specific reference
    // (e.g. a txid, once observed) instead of a preimage/bolt11.
    if (rec.paymentOption !== "lightning") {
      res.json({
        status: "OK",
        settled: rec.settled,
        paymentOption: rec.paymentOption,
        ...(rec.paymentDestination ? { paymentDestination: rec.paymentDestination } : {}),
        paymentReference: rec.paymentReference,
      });
      return;
    }
    res.json({ status: "OK", settled: rec.settled, preimage: rec.settled ? rec.preimage : null, pr: rec.pr });
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
      callback: `${settings.baseUrl()}/lnurl/${id}/callback`,
      minSendable: settings.minSendable(),
      maxSendable: settings.maxSendable(),
      metadata: buildMetadata(),
      commentAllowed: 140,
    };

    res.json(response);
  });

  // ─── GET /lnurl/:id/callback?amount=<msat> ──────────────────────────
  // LNURL-pay callback (LUD-06). Requests bolt11 from wallet via SSE.
  app.get("/lnurl/:id/callback", async (req, res) => {
    const { id } = req.params;
    const amountStr = strParam(req.query.amount);
    const comment = strParam(req.query.comment);

    if (!amountStr || isNaN(Number(amountStr))) {
      res.json({ status: "ERROR", reason: "Missing or invalid amount parameter" } satisfies LnurlErrorResponse);
      return;
    }
    // Non-positive amounts are refused before anything downstream (a provider must
    // never see them) — with the same bounds phrasing the relay has always used.
    if (Number(amountStr) <= 0) {
      res.json({ status: "ERROR", reason: `Amount must be between ${settings.minSendable()} and ${settings.maxSendable()} millisats` } satisfies LnurlErrorResponse);
      return;
    }
    await requestInvoiceAndRespond({
      sessions, sessionId: id, amountMsat: Number(amountStr), comment,
      min: settings.minSendable(), max: settings.maxSendable(), timeoutMs: settings.invoiceTimeoutMs(),
      offlineReason: "This LNURL is no longer active", store, baseUrl: settings.baseUrl(), res,
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

  // ─── POST /lnurl/session/:id/settled ─────────────────────────────────
  // LUD-21: the wallet reports the preimage once its invoice settles. Authed by the
  // session token; the record is keyed by sha256(preimage), which must match a payment
  // hash this session issued (so a wallet can only settle its own invoices).
  app.post("/lnurl/session/:id/settled", (req, res) => {
    const { id } = req.params;
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token || !sessions.verifyToken(id, token)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const preimage = (req.body as { preimage?: string } | undefined)?.preimage;
    if (!preimage || !/^[0-9a-f]{64}$/i.test(preimage)) {
      res.status(400).json({ error: "Missing or invalid preimage" });
      return;
    }
    const hash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
    const rec = store.get(hash);
    if (!rec || rec.sessionId !== id) {
      res.status(404).json({ error: "No settlement record for this session" });
      return;
    }
    store.markSettled(hash, preimage);
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
      const origin = `${req.protocol}://${domain.domain}`;
      const options = advertisedOptions(address);
      const units = quoteProvider?.units() ?? [];
      const response: LnurlPayMetadata = {
        tag: "payRequest",
        callback: `${origin}/.well-known/lnurlp/${username}/callback`,
        minSendable: domain.minSendable ?? settings.minSendable(),
        maxSendable: domain.maxSendable ?? settings.maxSendable(),
        metadata: buildMetadata(`${username}@${domain.domain}`),
        commentAllowed: 140,
        ...(options.length ? { paymentOptions: options } : {}),
        ...(units.length ? { units } : {}),
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
      if (!address || address.status !== "active") {
        res.json({ status: "ERROR", reason: "Unknown LN address" } satisfies LnurlErrorResponse);
        return;
      }
      const amountStr = strParam(req.query.amount);
      const comment = strParam(req.query.comment);
      if (!amountStr || isNaN(Number(amountStr))) {
        res.json({ status: "ERROR", reason: "Missing or invalid amount parameter" } satisfies LnurlErrorResponse);
        return;
      }
      let amountMsat = Number(amountStr);
      const min = domain.minSendable ?? settings.minSendable();
      const max = domain.maxSendable ?? settings.maxSendable();
      const paymentOptionId = strParam(req.query.paymentOption);
      // Non-positive amounts are refused before the quote/provider path.
      if (amountMsat <= 0) {
        res.json({ status: "ERROR", reason: `Amount must be between ${min} and ${max} millisats` } satisfies LnurlErrorResponse);
        return;
      }

      // LUD-XX paymentOptions: resolve the wallet's selected rail. "lightning" (or absent)
      // falls through to the BOLT11 flow below; a destination rail (arkade) returns the
      // registered address + a non-`pr` verify record.
      const resolved = resolvePaymentOption(paymentOptionId, address);
      if (resolved.kind === "error") {
        res.json({ status: "ERROR", reason: resolved.reason } satisfies LnurlErrorResponse);
        return;
      }

      // LUD-XX paymentQuote: a unit-denominated request is quoted to a msat amount by the
      // injected provider (lightning path only). Absent unit ⇒ amount stays msat.
      const unit = strParam(req.query.unit);
      const receiveUnit = strParam(req.query.receiveUnit);
      let paymentQuote: PaymentQuote | undefined;
      if (unit !== undefined || receiveUnit !== undefined) {
        if (resolved.kind === "destination") {
          res.json({ status: "ERROR", reason: "unit is not supported for this paymentOption" } satisfies LnurlErrorResponse);
          return;
        }
        const q = applyQuote(quoteProvider, { amount: amountMsat, unit, receiveUnit, paymentOption: paymentOptionId });
        if (!q.ok) {
          res.json({ status: "ERROR", reason: q.reason } satisfies LnurlErrorResponse);
          return;
        }
        amountMsat = q.amountMsat;
        paymentQuote = q.paymentQuote;
      }

      if (resolved.kind === "destination") {
        // Unauthed store-writing branch — same per-IP guard as the offline-swap branch.
        if (!addressCallbackLimiter.allow(req.ip ?? "unknown")) {
          res.status(429).json({ status: "ERROR", reason: "Too many requests" } satisfies LnurlErrorResponse);
          return;
        }
        if (amountMsat < min || amountMsat > max) {
          res.json({ status: "ERROR", reason: `Amount must be between ${min} and ${max} millisats` } satisfies LnurlErrorResponse);
          return;
        }
        // LUD-XX (lnurl/luds#303): a non-pr option MUST honor the requested amount
        // exactly and MUST NOT round — a sub-satoshi amount is not exactly
        // representable in a whole-sat destination payment, so reject it.
        if (amountMsat % 1000 !== 0) {
          res.json({ status: "ERROR", reason: "Amount must be a whole number of satoshis" } satisfies LnurlErrorResponse);
          return;
        }
        // The payer pays the destination directly, so the server isn't in the payment path:
        // `verify` records the agreed amount, but `settled` only flips once an Arkade watcher
        // observes the payment (follow-up). Keyed by an opaque verify id (not a payment hash).
        // No SSE session needed on a destination rail — the record keeps one only for shape.
        const verifyId = randomBytes(16).toString("hex");
        store.create({
          paymentHash: verifyId,
          pr: "",
          sessionId: address.sessionId ?? `addr:${address.id}`,
          paymentOption: resolved.paymentOption,
          paymentDestination: resolved.paymentDestination,
          amountMsat,
        });
        res.json({
          status: "OK",
          paymentOption: resolved.paymentOption,
          paymentDestination: resolved.paymentDestination,
          verify: `${settings.baseUrl()}/lnurl/verify/${verifyId}`,
        } satisfies LnurlPayDestinationResponse);
        return;
      }

      // Offline receive: no live SSE session for this address, but it opted in with an
      // Arkade identity, so the server quotes a corridor swap paying it (covclaimd claims it).
      // The corridor never touches the session, so a sessionless address is served too.
      if (creator && address.arkadeAddress && address.claimPublicKey && (!address.sessionId || !sessions.isActive(address.sessionId))) {
        if (!addressCallbackLimiter.allow(req.ip ?? "unknown")) {
          res.status(429).json({ status: "ERROR", reason: "Too many requests" } satisfies LnurlErrorResponse);
          return;
        }
        if (amountMsat < min || amountMsat > max) {
          res.json({ status: "ERROR", reason: `Amount must be between ${min} and ${max} millisats` } satisfies LnurlErrorResponse);
          return;
        }
        // The corridor deals in whole sats; sub-sat amounts would truncate silently.
        if (amountMsat % 1000 !== 0) {
          res.json({ status: "ERROR", reason: "Amount must be a whole number of satoshis" } satisfies LnurlErrorResponse);
          return;
        }
        await createOfflineSwapAndRespond({
          creator, store, baseUrl: settings.baseUrl(), amountMsat,
          receiveAddress: address.arkadeAddress, claimPublicKey: address.claimPublicKey, addressId: address.id, paymentQuote, res,
        });
        return;
      }

      // The lightning relay needs a live session to request the invoice from.
      if (!address.sessionId) {
        res.json({ status: "ERROR", reason: `${username}@${domain.domain} is currently offline` } satisfies LnurlErrorResponse);
        return;
      }

      await requestInvoiceAndRespond({
        sessions, sessionId: address.sessionId, amountMsat, comment,
        min, max, timeoutMs: settings.invoiceTimeoutMs(),
        offlineReason: `${username}@${domain.domain} is currently offline`,
        store, baseUrl: settings.baseUrl(), paymentQuote, res,
      });
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
          const lnurl = encodeLnurl(`${req.protocol}://${domain.domain}/.well-known/lnurlp/${address.username}`);
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

      // ─── POST /lnurl/address/:username/arkade ──────────────────────────
      // Register the Arkade receive identity for offline receive on an owned address.
      app.post("/lnurl/address/:username/arkade", (req, res) => {
        const domainName = domainFromHost((req.body?.domain as string | undefined) ?? req.get("host") ?? undefined);
        const domain = domainName ? deps.repos.domains.getByDomain(domainName) : undefined;
        if (!domain) { res.status(404).json({ error: "Unknown domain" }); return; }
        const auth = req.headers.authorization;
        const token = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
        if (!token) { res.status(401).json({ error: "Unauthorized" }); return; }
        const { arkadeAddress, claimPublicKey } = (req.body ?? {}) as { arkadeAddress?: string; claimPublicKey?: string };
        // Compressed 33-byte key (02/03 prefix) — the covenant's receiver role.
        if (!arkadeAddress || typeof arkadeAddress !== "string" || !claimPublicKey || !/^0[23][0-9a-f]{64}$/i.test(claimPublicKey)) {
          res.status(400).json({ error: "arkadeAddress and a compressed-hex claimPublicKey (02/03 + 64 hex) are required" });
          return;
        }
        try {
          ArkAddress.decode(arkadeAddress);
        } catch {
          res.status(400).json({ error: "arkadeAddress is not a valid Arkade address" });
          return;
        }
        const ok = addressService.setOfflineReceive(domain, req.params.username, token, { arkadeAddress, claimPublicKey });
        if (!ok) { res.status(404).json({ error: "Address not found or not owned by this token" }); return; }
        res.json({ ok: true });
      });
    }
  }

  return app;
}
