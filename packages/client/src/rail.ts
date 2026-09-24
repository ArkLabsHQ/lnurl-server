/**
 * LNURL payment rails for `@arkade-os/sdk`'s `PaymentRouter`.
 *
 * The SDK exports `isLnurl` with a standing `TODO(lnurl)` and no rail consuming
 * it, so `route()` throws on a Lightning address today. These fill that gap, and
 * they live here rather than upstream because a rail needs an LNURL client —
 * the same reason the solver rails ship from `@arkade-os/swap` and are
 * registered by the app.
 *
 * A rail here is a decorator, not a payment method: it turns an LNURL target
 * into a concrete one and delegates to the rail that already pays that target.
 * So the fee, expiry and execution are the inner rail's, and the router ranks
 * `lnurl-arkade` against `lnurl-lightning` the same way it ranks anything else
 * — through `priority` and `tieBreak`, rather than a hand-rolled preference.
 */
import { isLnurl } from "@arkade-os/sdk";
import type { PaymentRail, PaymentRequest, RouteQuote, RouterContext } from "@arkade-os/sdk";
import { LnurlError } from "./errors.js";
import type { LnurlClient } from "./index.js";
import type { PayRequest } from "./types.js";

export const LNURL_ARKADE_RAIL = "lnurl-arkade";
export const LNURL_LIGHTNING_RAIL = "lnurl-lightning";

export interface LnurlRailDeps {
  /** Payer surface only; needs no `baseUrl`. */
  client: LnurlClient;
  /** Pays the Arkade destination the callback returns — normally `arkRail()`. */
  arkade: PaymentRail;
  /** Pays the BOLT11 the callback returns — normally `solverLightningRail(...)`.
   *  Omit it and no lightning rail is registered, rather than one that cannot pay. */
  lightning?: PaymentRail;
  comment?: string;
  /** How long one target's payRequest is reused across `available()`/`quote()`. */
  ttlMs?: number;
}

/**
 * Both rails for one client, sharing one resolve.
 *
 * Returned together because the sharing is the point: `options()` calls
 * `available()` on every matching rail, and separate factories would each
 * fetch the same payRequest.
 */
export function lnurlRails(deps: LnurlRailDeps): PaymentRail[] {
  const ttlMs = deps.ttlMs ?? 30_000;
  const cache = new Map<string, { at: number; pr: Promise<PayRequest> }>();

  const resolveOnce = (raw: string): Promise<PayRequest> => {
    const key = raw.trim();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.pr;
    const pr = deps.client.resolve(key).catch((err) => { cache.delete(key); throw err; });
    cache.set(key, { at: Date.now(), pr });
    return pr;
  };

  const rails = [makeRail("arkade", LNURL_ARKADE_RAIL, deps.arkade, deps, resolveOnce)];
  if (deps.lightning) {
    rails.push(makeRail("lightning", LNURL_LIGHTNING_RAIL, deps.lightning, deps, resolveOnce));
  }
  return rails;
}

function makeRail(
  type: "arkade" | "lightning",
  id: string,
  inner: PaymentRail,
  deps: LnurlRailDeps,
  resolveOnce: (raw: string) => Promise<PayRequest>,
): PaymentRail {
  return {
    id,
    // The SDK's own predicate, which is deliberately looser than this package's
    // isValidLnUrl: classification is format-only and synchronous, so the rail
    // claims the shape here and lets resolve() in available() reject a bad
    // checksum. Using it is also what finally gives `isLnurl` a consumer.
    match: (req: PaymentRequest) => isLnurl(req.raw.trim()),

    async available(req: PaymentRequest) {
      let pr: PayRequest;
      try {
        pr = await resolveOnce(req.raw);
      } catch {
        return false;
      }
      // A session LNURL takes an amount and a comment and nothing else, so it
      // serves lightning alone and rejects a `paymentOption` outright.
      if (pr.source.surface === "session") return type === "lightning";

      // No `paymentOptions` at all (not an empty array) is LUD-06 silence: a
      // plain payRequest from a non-Arkade server, which is lightning-only on
      // its top-level minSendable/maxSendable.
      if (pr.paymentOptions === undefined) {
        if (type !== "lightning") return false;
        if (req.amount === undefined) return true;
        const msat = req.amount * 1000;
        return msat >= pr.minSendable && msat <= pr.maxSendable;
      }

      const option = pr.paymentOptions.find((o) => o.type === type && o.available !== false);
      if (!option) return false;
      if (req.amount === undefined) return true;

      const msat = req.amount * 1000;
      return msat >= (option.minSendable ?? pr.minSendable) && msat <= (option.maxSendable ?? pr.maxSendable);
    },

    async quote(req: PaymentRequest, ctx: RouterContext): Promise<RouteQuote> {
      const pr = await resolveOnce(req.raw);
      if (req.amount === undefined) throw new LnurlError(`${id} needs an explicit amount`);

      const option = pr.source.surface === "session"
        ? undefined
        : pr.paymentOptions?.find((o) => o.type === type && o.available !== false)?.id;
      const result = await deps.client.requestInvoice(pr, {
        amountSat: req.amount,
        ...(option !== undefined ? { paymentOption: option } : {}),
        ...(deps.comment !== undefined ? { comment: deps.comment } : {}),
      });

      // The invoice carries its own amount and solverLightningRail refuses a
      // request that restates it differently, so only the destination branch
      // passes one on.
      const delegated = result.kind === "bolt11"
        ? { raw: result.pr }
        : { raw: destinationOf(result.paymentDestination, id), amount: req.amount };

      const quote = await inner.quote(delegated, ctx);
      return {
        ...quote,
        railId: id,
        meta: { ...quote.meta, lnurl: { target: req.raw, via: inner.id, verify: result.verify, verifyBatch: result.verifyBatch } },
      };
    },
  };
}

function destinationOf(destination: string | undefined, id: string): string {
  if (!destination) throw new LnurlError(`${id}: the callback returned no payment destination`);
  return destination;
}
