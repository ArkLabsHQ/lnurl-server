import { Router } from "express";
import { ArkAddress } from "@arkade-os/sdk";
import { encodeLnurl } from "../lnurl.js";
import { isNameless } from "../services/addresses.js";
import { isValidToken } from "../session-token.js";
import type { AddressRow, DomainRow } from "../types/index.js";
import { BadRequest, NotFound, TooManyRequests, Unauthorized } from "../http-errors.js";
import { bearerToken, domainFor, strParam } from "../http-params.js";
import type { ServerContext } from "../server-context.js";

/** One shape for register, upgrade and list, so they cannot drift. A flagged row's
 *  lnurl is the stable session one (survives an upgrade); an unflagged row keeps
 *  today's .well-known URL. */
function addressView(domain: DomainRow, a: AddressRow, proto: string) {
  const nameless = isNameless(a);
  const sessionLnurl = a.sessionLnurl ? encodeLnurl(`${proto}://${domain.domain}/lnurl/${a.sessionId}`) : null;
  return {
    lightningAddress: nameless ? null : `${a.username}@${domain.domain}`,
    lnurl: sessionLnurl ?? encodeLnurl(`${proto}://${domain.domain}/.well-known/lnurlp/${a.username}`),
    username: nameless ? null : a.username,
    handle: nameless ? a.sessionId! : a.username,
    domain: domain.domain,
    status: a.status,
    nameless,
    sessionLnurl,
  };
}

/** The owner's API for their Lightning addresses, authed by the session token. */
export function lnurlAddressRoutes({ repos, addressService, registrationLimiter: limiter, store }: ServerContext): Router {
  const r = Router();

  // Must be mounted before /lnurl/:id, or "address" is captured as a session id.
  r.get("/lnurl/address", (req, res) => {
    if (!addressService) throw new NotFound("Not found");
    const token = bearerToken(req);
    if (!token) throw new Unauthorized();
    const list = addressService.listByToken(token).map((a) => {
      const domain = repos!.domains.getById(a.domainId)!;
      return { ...addressView(domain, a, req.protocol), createdAt: a.createdAt };
    });
    res.json(list);
  });

  // Public + unauthed. Mounted before /lnurl/:id or "domain" is captured as a session id.
  r.get("/lnurl/domain", (req, res) => {
    if (!repos) throw new NotFound("Not found");
    const domain = domainFor(repos, strParam(req.query.domain) ?? req.get("host"));
    if (!domain || !domain.enabled) throw new NotFound("Unknown or disabled domain");
    res.json({
      domain: domain.domain,
      allocationModes: domain.allocationModes,
      usernameRules: { minLen: domain.usernameMinLen, maxLen: domain.usernameMaxLen, pattern: domain.usernamePattern },
      requireApiKey: domain.requireApiKey,
    });
  });

  if (!repos || !addressService) return r;

  r.post("/lnurl/address", (req, res) => {
    const domain = domainFor(repos, (req.body?.domain as string | undefined) ?? req.get("host"));
    if (!domain || !domain.enabled) throw new NotFound("Unknown or disabled domain");

    // Rate-limit keys on req.ip — only trustworthy when `trust proxy` matches the
    // actual proxy hop count (see app.set("trust proxy", ...) in server.ts).
    if (limiter && !limiter.allow(req.ip ?? "unknown")) throw new TooManyRequests();

    if (domain.requireApiKey) {
      const key = req.get("x-api-key");
      if (!key || !repos.apiKeys.verify(key, domain.id)) throw new Unauthorized("Valid X-API-Key required");
    }

    const { token, username, claimCode, nameless } = (req.body ?? {}) as { token?: string; username?: string; claimCode?: string; nameless?: boolean };
    if (!token) throw new BadRequest("Missing token");
    if (nameless && (username || claimCode)) throw new BadRequest("nameless cannot be combined with username or claimCode", { code: "invalid_username" });

    if (nameless) {
      const { address, created } = addressService.registerNameless({ domain, token });
      res.status(created ? 201 : 200).json(addressView(domain, address, req.protocol));
      return;
    }
    const { address, created } = addressService.register({ domain, username, token, claimCode });
    res.status(created ? 201 : 200).json(addressView(domain, address, req.protocol));
  });

  r.patch("/lnurl/address/:handle", (req, res) => {
    const domain = domainFor(repos, strParam(req.query.domain) ?? (req.body?.domain as string | undefined) ?? req.get("host"));
    if (!domain || !domain.enabled) throw new NotFound("Unknown or disabled domain");
    if (limiter && !limiter.allow(req.ip ?? "unknown")) throw new TooManyRequests();
    const token = bearerToken(req);
    if (!isValidToken(token)) throw new Unauthorized();
    const { username, claimCode } = (req.body ?? {}) as { username?: string; claimCode?: string };
    const address = addressService.upgrade({ domain, handle: req.params.handle, token, username, claimCode });
    res.json(addressView(domain, address, req.protocol));
  });

  r.delete("/lnurl/address/:handle", (req, res) => {
    const domain = domainFor(repos, (req.query.domain as string | undefined) ?? req.get("host"));
    if (!domain) throw new NotFound("Unknown domain");
    const token = bearerToken(req);
    if (!isValidToken(token)) throw new Unauthorized();
    if (!addressService.revokeOwn(domain, req.params.handle, token)) throw new NotFound("Address not found or not owned by this token");
    res.json({ ok: true });
  });

  // Register the Arkade receive identity for offline receive on an owned address.
  r.post("/lnurl/address/:handle/arkade", (req, res) => {
    const domain = domainFor(repos, (req.body?.domain as string | undefined) ?? req.get("host"));
    if (!domain) throw new NotFound("Unknown domain");
    const token = bearerToken(req);
    if (!isValidToken(token)) throw new Unauthorized();
    const { arkadeAddress, claimPublicKey, boardingAddress } = (req.body ?? {}) as
      { arkadeAddress?: string; claimPublicKey?: string; boardingAddress?: string };
    // Compressed 33-byte key (02/03 prefix) — the covenant's receiver role.
    if (!arkadeAddress || typeof arkadeAddress !== "string" || !claimPublicKey || !/^0[23][0-9a-f]{64}$/i.test(claimPublicKey)) {
      throw new BadRequest("arkadeAddress and a compressed-hex claimPublicKey (02/03 + 64 hex) are required");
    }
    try {
      ArkAddress.decode(arkadeAddress);
    } catch {
      throw new BadRequest("arkadeAddress is not a valid Arkade address");
    }
    // Optional: the onchain rail is advertised only for an address that has
    // one, and it is the owner's own onchain key, so it is validated for
    // shape here and never derived from anything the server holds.
    if (boardingAddress !== undefined && (typeof boardingAddress !== "string" || boardingAddress.length === 0)) {
      throw new BadRequest("boardingAddress must be a non-empty string when provided");
    }
    const ok = addressService.setOfflineReceive(domain, req.params.handle, token, {
      arkadeAddress,
      claimPublicKey,
      ...(boardingAddress !== undefined ? { boardingAddress } : {}),
    });
    if (!ok) throw new NotFound("Address not found or not owned by this token");
    res.json({ ok: true });
  });

  // Owner payment activity as a sync source, oldest first with an inclusive nextSince cursor.
  r.get("/lnurl/address/:handle/payments", (req, res) => {
    const domain = domainFor(repos, strParam(req.query.domain) ?? req.get("host"));
    if (!domain || !domain.enabled) throw new NotFound("Unknown or disabled domain");
    const token = bearerToken(req);
    // isValidToken, not just a presence check: Buffer.from(hex) truncates at
    // the first invalid pair, so `<token>zz` would derive the owner's id.
    if (!isValidToken(token)) throw new Unauthorized();
    const address = addressService.ownedByHandle(domain, req.params.handle, token);
    if (!address || address.status !== "active") throw new NotFound("Address not found or not owned by this token");
    const sinceNum = Number(strParam(req.query.since));
    const since = Number.isFinite(sinceNum) ? sinceNum : undefined;
    const limitNum = Number(strParam(req.query.limit));
    const limit = Number.isFinite(limitNum) ? Math.min(200, Math.max(1, Math.floor(limitNum))) : 50;
    const payments = store.listByAddress(address.id, limit, since === undefined ? undefined : { since });
    const last = payments[payments.length - 1];
    const nameless = isNameless(address);
    res.json({
      source: {
        domain: domain.domain,
        lightningAddress: nameless ? null : `${address.username}@${domain.domain}`,
        handle: nameless ? address.sessionId! : address.username,
      },
      payments,
      nextSince: last ? last.createdAt : (since ?? 0),
    });
  });

  return r;
}
