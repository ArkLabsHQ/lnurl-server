import { arkRail, BIP21, createDefaultPaymentRouter, type PaymentRail, type PaymentRequest, type Wallet } from "@arkade-os/sdk";
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

/** The invoice prices its own leg, so a restated BIP21 amount must not drop it. */
function invoicePricedLeg(rail: PaymentRail): PaymentRail {
  const leg = (req: PaymentRequest): PaymentRequest => {
    if (req.amount === undefined || req.amount !== BIP21.amountSats(req.raw)) return req;
    const { amount: _restated, ...rest } = req;
    return rest;
  };
  return {
    id: rail.id,
    match: (req, ctx) => rail.match(req, ctx),
    available: (req, ctx) => rail.available?.(leg(req), ctx) ?? true,
    quote: (req, ctx) => rail.quote(leg(req), ctx),
  };
}
