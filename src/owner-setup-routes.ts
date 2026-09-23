import type express from "express";
import type { Repositories } from "./db/repositories/index.js";
import type { OwnerSetupRecord } from "./db/repositories/owner-setups.js";
import { decodeOwnerSetup } from "./enclave/owner-setup.js";
import { encodeLnurl } from "./lnurl.js";
import { RateLimiter } from "./rate-limit.js";
import { effectiveRails, type ServerRailCaps } from "./rails.js";
import { committedSetup, OwnerSetupError, setupRailAddress, type OwnerSetupService } from "./owner-setup-service.js";

const SUBMISSIONS_PER_IDENTITY_PER_MINUTE = 10;
const HISTORY_DEFAULT = 20;
const HISTORY_MAX = 100;

const strParam = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const b64 = (b: Uint8Array | null): string | null => (b === null ? null : Buffer.from(b).toString("base64url"));
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

function base64url(value: unknown, name: string, length?: number): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new OwnerSetupError(400, "invalid_request", `${name} must be base64url`);
  const bytes = Buffer.from(value, "base64url");
  if (length !== undefined && bytes.length !== length) throw new OwnerSetupError(400, "invalid_request", `${name} must be ${length} bytes`);
  return new Uint8Array(bytes);
}

function recordView(r: OwnerSetupRecord) {
  return {
    revision: r.revision, digest: r.digest, previousDigest: r.previousDigest, intent: r.intent,
    payload: b64(r.payload), signature: b64(r.signature), countersignature: b64(r.countersignature),
    signerPublicKey: hex(r.signerPublicKey), ownerPublicKey: hex(r.ownerPublicKey), acceptedAt: r.acceptedAt,
  };
}

function nameOf(req: express.Request, res: express.Response): { domain: string; username: string } | undefined {
  const domain = strParam(req.query.domain)?.toLowerCase();
  const username = strParam(req.query.username)?.toLowerCase();
  if (domain && username) return { domain, username };
  res.status(400).json({ error: "domain and username are required", code: "invalid_request" });
  return undefined;
}

/** Enrollment and public verification of owner-signed setups. The name a submission acts on
 *  comes from the signed bytes alone, never from the Host header or the path. */
export function mountOwnerSetupRoutes(app: express.Express, deps: {
  service: OwnerSetupService;
  repos: Repositories;
  railCaps: () => ServerRailCaps;
  ipLimiter?: RateLimiter;
}): void {
  const perIdentity = new RateLimiter(SUBMISSIONS_PER_IDENTITY_PER_MINUTE, 60_000);

  app.post("/lnurl/setup", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      if (deps.ipLimiter && !deps.ipLimiter.allow(req.ip ?? "unknown")) throw new OwnerSetupError(429, "rate_limited", "Too many requests");
      const payload = base64url(body.payload, "payload");
      const signature = base64url(body.signature, "signature", 64);
      const countersignature = body.countersignature === undefined ? undefined : base64url(body.countersignature, "countersignature", 64);
      if (body.token !== undefined && typeof body.token !== "string") throw new OwnerSetupError(400, "invalid_request", "token must be a hex string");
      let key: string;
      try {
        const named = decodeOwnerSetup(payload);
        key = `${named.domain}/${named.username}`;
      } catch (error) {
        throw new OwnerSetupError(400, "invalid_payload", (error as Error).message);
      }
      if (!perIdentity.allow(key)) throw new OwnerSetupError(429, "rate_limited", "Too many submissions for this identity");

      const { applied, setup, identity } = deps.service.submit({ payload, signature, countersignature, token: body.token as string | undefined });
      res.json({
        ok: true, applied, domain: setup.domain, username: setup.username,
        revision: identity.currentRevision, digest: identity.currentDigest, state: identity.state,
        lightningAddress: `${setup.username}@${setup.domain}`,
        lnurl: encodeLnurl(`${req.protocol}://${setup.domain}/.well-known/lnurlp/${setup.username}`),
        rails: {
          requested: setup.rails,
          effective: effectiveRails(setupRailAddress(setup), deps.railCaps())
            .filter((state) => setup.rails.includes(state.id))
            .map((state) => ({ id: state.id, available: state.available, ...(state.reason ? { reason: state.reason } : {}) })),
        },
      });
    } catch (error) {
      if (!(error instanceof OwnerSetupError)) throw error;
      res.status(error.status).json({ error: error.message, code: error.code });
    }
  });

  app.get("/lnurl/setup", (req, res) => {
    const name = nameOf(req, res);
    if (!name) return;
    const committed = committedSetup(deps.repos, name.domain, name.username);
    if (!committed) {
      res.status(404).json({ error: `no owner-signed identity for ${name.username}@${name.domain}`, code: "unknown_identity" });
      return;
    }
    const { setup, identity, record } = committed;
    res.json({
      ...name, ...recordView(record), state: identity.state,
      suspended: identity.suspendedAt !== null, suspensionReason: identity.suspensionReason,
      deployment: setup.deployment, tenant: identity.tenant,
    });
  });

  app.get("/lnurl/setup/history", (req, res) => {
    const name = nameOf(req, res);
    if (!name) return;
    if (!deps.repos.ownerSetups.identity(name.domain, name.username)) {
      res.status(404).json({ error: `no owner-signed identity for ${name.username}@${name.domain}`, code: "unknown_identity" });
      return;
    }
    const raw = Number(strParam(req.query.limit));
    const limit = Number.isFinite(raw) ? Math.min(HISTORY_MAX, Math.max(1, Math.floor(raw))) : HISTORY_DEFAULT;
    res.json({ ...name, revisions: deps.repos.ownerSetups.history(name.domain, name.username, limit).map(recordView) });
  });
}
