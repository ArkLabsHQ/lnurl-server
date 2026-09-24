import { Router, type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import type { Repositories } from "../db/repositories/index.js";
import { RateLimiter } from "../rate-limit.js";
import { resolvePaymentOption } from "../payment-options.js";
import {
  advertisedBounds,
  advertisedRailOptions,
  effectiveRails,
  optionBounds,
  railBounds,
  type AddressRailState,
  type Bounds,
  type ServerRailCaps,
} from "../rails.js";
import { applyQuote, type PaymentQuote } from "../quote-provider.js";
import type { DerivedDestination } from "../covenant-destination.js";
import type { AddressRow, DomainRow, LnurlPayDestinationResponse, LnurlPayMetadata } from "../types/index.js";
import { LnurlError } from "../http-errors.js";
import { domainFor, originOf, strParam } from "../http-params.js";
import { buildMetadata, createOfflineSwapInvoice, destinationUri, requestSessionInvoice } from "../pay-flow.js";
import type { ServerContext } from "../server-context.js";
import { isNameless } from "../address-service.js";
import { BATCH_PATH } from "../verify-batch.js";

const DEFAULT_DESTINATION_WATCH_MS = 604_800_000;

const railStatesFor = (address: { arkadeAddress: string | null; claimPublicKey: string | null; disabledRails: readonly unknown[] }, caps: ServerRailCaps): Map<string, AddressRailState> =>
  new Map(effectiveRails(address, caps).map((s) => [s.id, s]));

/** LUD-16 `user@domain`, and a flagged address at its session LNURL: the pay request and its
 *  callback, across every rail an address has. */
export function wellKnownRoutes(ctx: ServerContext, repos: Repositories): Router {
  const { config, deps, sessions, store, settings, logger, currentRailCaps } = ctx;
  const creator = deps?.offlineSwapCreator;
  const quoteProvider = deps?.quoteProvider;
  const covenantDestinations = deps?.covenantDestinations;
  // Tighter per-IP guard on callback branches that cost resources without a live
  // wallet session: each offline-swap hit asks the solver for a fresh quote, and
  // each destination hit writes a store record.
  const addressCallbackLimiter = new RateLimiter(30, 60_000);
  let offlineQuotes = 0;
  const r = Router();

  const activeAddress = (host: string | undefined, rawUsername: string) => {
    const domain = domainFor(repos, host);
    if (!domain || !domain.enabled) throw new LnurlError("Unknown or disabled domain");
    const username = rawUsername.toLowerCase();
    const address = repos.addresses.getByDomainAndUsername(domain.id, username);
    if (!address || address.status !== "active" || isNameless(address)) throw new LnurlError("Unknown LN address");
    return { domain, username, address };
  };

  // Only an active flagged row on the Host's enabled domain; anything else stays a plain session LNURL.
  const sessionLnurlRow = (req: Request, id: string): { domain: DomainRow; address: AddressRow } | undefined => {
    const domain = domainFor(repos, req.get("host"));
    if (!domain || !domain.enabled) return undefined;
    const address = repos.addresses.getSessionLnurl(domain.id, id);
    return address ? { domain, address } : undefined;
  };

  const envelope = (domain: DomainRow, address: AddressRow) => ({
    railAddress: { arkadeAddress: address.arkadeAddress, claimPublicKey: address.claimPublicKey, boardingAddress: address.boardingAddress, disabledRails: address.disabledRails },
    base: { min: domain.minSendable ?? settings.minSendable(), max: domain.maxSendable ?? settings.maxSendable() } as Bounds,
  });

  const payRequest = (res: Response, domain: DomainRow, address: AddressRow, callback: string): void => {
    const { railAddress, base } = envelope(domain, address);
    const railCaps = currentRailCaps();
    const options = advertisedRailOptions(railAddress, railCaps, base);
    const advertised = advertisedBounds(railAddress, railCaps, base);
    const units = quoteProvider?.units() ?? [];
    res.json({
      tag: "payRequest",
      callback,
      minSendable: advertised.min,
      maxSendable: advertised.max,
      metadata: buildMetadata(isNameless(address) ? undefined : `${address.username}@${domain.domain}`),
      commentAllowed: 140,
      ...(options.length ? { paymentOptions: options } : {}),
      ...(units.length ? { units } : {}),
    } satisfies LnurlPayMetadata);
  };

  const payCallback = async (req: Request, res: Response, domain: DomainRow, address: AddressRow): Promise<void> => {
    // `base` is the envelope only. Each branch below narrows it to what its own rail
    // can carry, because the rail that serves decides the real bound.
    const { railAddress, base } = envelope(domain, address);
    const offlineReason = isNameless(address) ? "This LNURL is currently offline" : `${address.username}@${domain.domain} is currently offline`;
    const amountStr = strParam(req.query.amount);
    const comment = strParam(req.query.comment);
    if (!amountStr || !Number.isSafeInteger(Number(amountStr))) throw new LnurlError("Missing or invalid amount parameter");
    let amountMsat = Number(amountStr);
    const paymentOptionId = strParam(req.query.paymentOption);
    // Non-positive amounts are refused before the quote/provider path.
    if (amountMsat <= 0) throw new LnurlError(`Amount must be between ${base.min} and ${base.max} millisats`);

    // LUD-XX paymentOptions: resolve the wallet's selected rail. "lightning" (or absent)
    // falls through to the BOLT11 flow below; a destination rail (arkade) returns the
    // registered address + a non-`pr` verify record.
    const resolved = resolvePaymentOption(paymentOptionId, address);
    if (resolved.kind === "error") throw new LnurlError(resolved.reason);
    // Per-address rail policy: a disabled rail fails loudly instead of serving.
    const railCaps = currentRailCaps();
    const railStates = railStatesFor(address, railCaps);
    if (resolved.kind === "destination" && railStates.get("arkade")?.enabled === false) {
      throw new LnurlError("paymentOption arkade is disabled for this address");
    }

    // LUD-XX paymentQuote: a unit-denominated request is quoted to a msat amount by the
    // injected provider (lightning path only). Absent unit ⇒ amount stays msat.
    const unit = strParam(req.query.unit);
    const receiveUnit = strParam(req.query.receiveUnit);
    let paymentQuote: PaymentQuote | undefined;
    if (unit !== undefined || receiveUnit !== undefined) {
      if (resolved.kind === "destination") throw new LnurlError("unit is not supported for this paymentOption");
      const q = applyQuote(quoteProvider, { amount: amountMsat, unit, receiveUnit, paymentOption: paymentOptionId });
      if (!q.ok) throw new LnurlError(q.reason);
      amountMsat = q.amountMsat;
      paymentQuote = q.paymentQuote;
    }

    if (resolved.kind === "destination") {
      // Unauthed store-writing branch — same per-IP guard as the offline-swap branch.
      if (!addressCallbackLimiter.allow(req.ip ?? "unknown")) throw new LnurlError("Too many requests", 429);
      const arkadeBounds = optionBounds("arkade", railAddress, railCaps, base) ?? base;
      if (amountMsat < arkadeBounds.min || amountMsat > arkadeBounds.max) {
        throw new LnurlError(`Amount must be between ${arkadeBounds.min} and ${arkadeBounds.max} millisats`);
      }
      // LUD-XX (lnurl/luds#303): a non-pr option MUST honor the requested amount
      // exactly and MUST NOT round — a sub-satoshi amount is not exactly
      // representable in a whole-sat destination payment, so reject it.
      if (amountMsat % 1000 !== 0) throw new LnurlError("Amount must be a whole number of satoshis");
      // The payer pays the destination directly, so the server isn't in the payment path:
      // `verify` records the agreed amount, but `settled` only flips once an Arkade watcher
      // observes the payment (follow-up). Keyed by an opaque verify id (not a payment hash).
      // No SSE session needed on a destination rail — the record keeps one only for shape.
      const verifyId = randomBytes(16).toString("hex");
      // The script identifies the payment outright. On failure fall back to the
      // static address: ambiguous, but being paid beats refusing.
      let derived: DerivedDestination | undefined;
      // Only the arkade rail: a covenant address is an Arkade destination, so
      // deriving one for any other destination rail replaces that rail's own
      // address with one on the wrong chain. The onchain rail pays a boarding
      // address and must keep it.
      if (
        resolved.paymentOption === "arkade" &&
        covenantDestinations && railStates.get("covenant")?.available && address.arkadeAddress && address.claimPublicKey
      ) {
        try {
          derived = await covenantDestinations.derive({
            arkadeAddress: address.arkadeAddress,
            claimPublicKey: address.claimPublicKey,
          });
        } catch (err) {
          console.warn(`covenant destination: derivation failed, using the static address:`, err);
        }
      }
      store.create({
        paymentHash: verifyId,
        pr: "",
        sessionId: address.sessionId ?? `addr:${address.id}`,
        addressId: address.id,
        paymentOption: resolved.paymentOption,
        paymentDestination: derived?.address ?? resolved.paymentDestination,
        amountMsat,
        // The script alone: it is the attribution key, and the contract registered
        // at derivation owns the preimage, the taptree and the payout script.
        ...(derived ? { covenantScript: derived.script } : {}),
      });
      // Only the static rail: a covenant destination is watched as a contract.
      if (resolved.paymentOption === "arkade" && !derived) {
        deps?.onDestinationIssued?.(resolved.paymentDestination);
      }
      const destination = derived?.address ?? resolved.paymentDestination;
      res.json({
        status: "OK",
        paymentOption: resolved.paymentOption,
        paymentDestination: destination,
        ...(destination ? { paymentURI: destinationUri(resolved.paymentOption, destination, amountMsat) } : {}),
        // Only for rails this server watches. The onchain rail is a static
        // boarding address nothing here observes, so it has no window to end.
        ...(resolved.paymentOption === "onchain"
          ? {}
          : { expiresAt: Math.floor((Date.now() + (config.destinationWatchMs ?? DEFAULT_DESTINATION_WATCH_MS)) / 1000) }),
        // Only when the destination identifies the payment. A covenant script
        // does; the static fallback is one address reused for every payment and
        // settled by amount/window correlation, so two concurrent payments of
        // the same size cannot be told apart and a payer polling verify could
        // be told someone else's arrived. The record is still written — the
        // watcher settles it and the activity list shows it — but the payer is
        // not handed a URL whose answer the server cannot stand behind.
        ...(derived ? { verify: `${settings.baseUrl()}/lnurl/verify/${verifyId}`, verifyBatch: `${settings.baseUrl()}${BATCH_PATH}` } : {}),
      } satisfies LnurlPayDestinationResponse);
      return;
    }

    // Offline receive: no live SSE session for this address, but it opted in with an
    // Arkade identity, so the server quotes a corridor swap paying it (covclaimd claims it).
    // The corridor never touches the session, so a sessionless address is served too.
    if (creator && address.arkadeAddress && address.claimPublicKey && (!address.sessionId || !sessions.isActive(address.sessionId))) {
      // Sessionless receive is the offline-swap rail: a disabled policy or an
      // unready discovery fails loudly per request while the process keeps
      // serving interactive sessions (never a silent stall).
      if (railStates.get("offline-swap")?.enabled === false) throw new LnurlError("offline receive is disabled for this address");
      if (!railCaps.discoveryReady) {
        throw new LnurlError(`offline receive unavailable: ${railCaps.discoveryReason ?? "no usable lightning-receive solver cards"}`);
      }
      if (!addressCallbackLimiter.allow(req.ip ?? "unknown")) throw new LnurlError("Too many requests", 429);
      const swapBounds = railBounds("offline-swap", railCaps, base);
      if (amountMsat < swapBounds.min || amountMsat > swapBounds.max) {
        throw new LnurlError(`Amount must be between ${swapBounds.min} and ${swapBounds.max} millisats`);
      }
      // The corridor deals in whole sats; reject before reserving capacity.
      if (amountMsat % 1000 !== 0) throw new LnurlError("Amount must be a whole number of satoshis");
      if (offlineQuotes >= (config.maxConcurrentOfflineQuotes ?? 20)) throw new LnurlError("Offline quote capacity reached", 429);
      offlineQuotes++;
      try {
        res.json(await createOfflineSwapInvoice({
          creator, store, offlineSwaps: deps?.offlineSwaps, baseUrl: settings.baseUrl(), amountMsat,
          receiveAddress: address.arkadeAddress, claimPublicKey: address.claimPublicKey, addressId: address.id, paymentQuote,
          echoLightningOption: Boolean(paymentOptionId),
          logger, requestId: res.locals.requestId as string,
        }));
      } finally {
        offlineQuotes--;
      }
      return;
    }

    // The lightning relay needs a live session to request the invoice from.
    if (!address.sessionId) throw new LnurlError(offlineReason);
    if (railStates.get("interactive-lightning")?.enabled === false) throw new LnurlError("lightning receive is disabled for this address");

    const interactiveBounds = railBounds("interactive-lightning", railCaps, base);
    res.json(await requestSessionInvoice({
      sessions, sessionId: address.sessionId, addressId: address.id, amountMsat, comment,
      min: interactiveBounds.min, max: interactiveBounds.max, timeoutMs: settings.invoiceTimeoutMs(),
      offlineReason,
      store, baseUrl: settings.baseUrl(), paymentQuote, echoLightningOption: Boolean(paymentOptionId),
      logger, requestId: res.locals.requestId as string,
    }));
  };

  r.get("/.well-known/lnurlp/:username", (req, res) => {
    const { domain, username, address } = activeAddress(req.get("host"), req.params.username);
    payRequest(res, domain, address, `${originOf(req, domain)}/.well-known/lnurlp/${username}/callback`);
  });

  r.get("/.well-known/lnurlp/:username/callback", async (req, res) => {
    const { domain, address } = activeAddress(req.get("host"), req.params.username);
    await payCallback(req, res, domain, address);
  });

  // Mounted before the session routes; any id that is not a flagged address falls through to them.
  r.get("/lnurl/:id", (req, res, next) => {
    const flagged = sessionLnurlRow(req, req.params.id);
    if (!flagged) return next();
    payRequest(res, flagged.domain, flagged.address, `${originOf(req, flagged.domain)}/lnurl/${req.params.id}/callback`);
  });

  r.get("/lnurl/:id/callback", async (req, res, next) => {
    const flagged = sessionLnurlRow(req, req.params.id);
    if (!flagged) return next();
    await payCallback(req, res, flagged.domain, flagged.address);
  });

  return r;
}
