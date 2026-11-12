import { arkRail, BIP21, createDefaultPaymentRouter, invoiceTarget, type PaymentRail, type PaymentRequest, type Wallet } from "@arkade-os/sdk";
import { amountMsatOf } from "./bolt11.js";
import { LnurlError } from "./errors.js";
import { createLnurlClient, type LnurlClient } from "./index.js";
import { lnurlRails } from "./rail.js";
import type { LnurlPaymentRouter, LnurlWallet } from "./wallet.js";

export function arkadePaymentRouter(opts: {
  wallet: LnurlWallet;
  router?: LnurlPaymentRouter;
  lightning?: PaymentRail;
  client?: LnurlClient;
  comment?: string;
}): LnurlPaymentRouter {
  // The SDK default needs a spending wallet; custom wallets supply their own router.
  const router = opts.router ?? createDefaultPaymentRouter(opts.wallet as Wallet);
  if (opts.lightning) router.use(invoicePricedLeg(opts.lightning));
  for (const rail of lnurlRails({
    client: opts.client ?? createLnurlClient(),
    arkade: arkRail(),
    ...(opts.lightning ? { lightning: opts.lightning } : {}),
    ...(opts.comment !== undefined ? { comment: opts.comment } : {}),
  })) {
    router.use(rail);
  }
  return router;
}

/** The invoice prices its own leg and swap's rail refuses any amount beside it. The invoice's own or the URI's `amount=`
 *  is dropped; any other is dropped for `available()` too, as the router swallows its errors, and fails at quote instead. */
function invoicePricedLeg(rail: PaymentRail): PaymentRail {
  const leg = (req: PaymentRequest): { req: PaymentRequest; conflict?: number } => {
    const invoice = invoiceTarget(req.raw);
    const msat = invoice === undefined ? undefined : amountMsatOf(invoice);
    if (req.amount === undefined || typeof msat !== "number") return { req };
    const { amount, ...rest } = req;
    return amount * 1000 === msat || amount === BIP21.amountSats(req.raw) ? { req: rest } : { req: rest, conflict: msat / 1000 };
  };
  return {
    id: rail.id,
    match: (req, ctx) => rail.match(req, ctx),
    available: (req, ctx) => rail.available?.(leg(req).req, ctx) ?? true,
    quote: async (req, ctx) => {
      const { req: priced, conflict } = leg(req);
      if (conflict !== undefined) throw new LnurlError(`${rail.id}: the invoice is for ${conflict} sats, not ${req.amount}`);
      return rail.quote(priced, ctx);
    },
  };
}
