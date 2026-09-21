/** The wallet-shaped facade: what a receiver holding an `@arkade-os/sdk` wallet
 *  would otherwise wire by hand. The low-level surface stays exported beneath it. */
import {
  arkRail,
  createDefaultPaymentRouter,
  type PaymentOption,
  type PaymentRail,
  type PaymentRouter,
  type RouterPreferences,
  type Wallet,
} from "@arkade-os/sdk";
import { bech32 } from "@scure/base";
import { arkadeIdentityRequest, deriveSessionTokenForIdentity } from "./arkade.js";
import { LnurlError } from "./errors.js";
import { createLnurlClient, type LnurlClient } from "./index.js";
import { lnurlRails } from "./rail.js";
import { syncPayments, type PaymentSyncStore, type StoredPayment } from "./sync.js";
import type { PayRequest, PaymentPage } from "./types.js";

/** The 1023 limit is LUD-01's, not bech32's default 90. */
export function encodeLnurl(url: string): string {
  return bech32.encode("lnurl", bech32.toWords(new TextEncoder().encode(url)), 1023);
}

export interface ArkadeLnurlOptions {
  wallet: Wallet;
  baseUrl: string;
  /** Defaults to `baseUrl`'s hostname, as the server derives it: a LUD-16
   *  domain cannot carry a port. */
  domain?: string;
  store?: PaymentSyncStore;
  lightningRail?: PaymentRail;
  client?: LnurlClient;
}

export interface ArkadeLnurl {
  /** Derived once; signs twice on the first call, nothing on later ones. */
  token(): Promise<string>;
  owned(): Promise<string | undefined>;
  /** Both halves matter: until the bind lands the address advertises no
   *  `paymentOptions` at all, so offline receive does not exist. */
  claim(username: string): Promise<{ username: string; lightningAddress: string }>;
  lightningAddress(username: string): string;
  /** Addressed through `baseUrl`, not the LUD-16 domain, which drops the port. */
  payRequest(username: string): Promise<PayRequest>;
  /** For a QR. */
  lnurl(username: string): string;
  payments(username: string, opts?: { since?: number; limit?: number }): Promise<PaymentPage>;
  sync(username: string): Promise<{ synced: number; failures: unknown[] }>;
  router(): PaymentRouter;
  options(target: string, amountSat: number, prefs?: RouterPreferences): Promise<PaymentOption[]>;
}

/** Ordered so the Arkade leg outranks the Lightning one for the same address:
 *  it delivers the full amount with no counterparty. */
export const DEFAULT_RAIL_PRIORITY = [
  "lnurl-arkade", "ark", "ark-asset", "lnurl-lightning", "solver-lightning", "onchain",
];

/** The SDK's router with the LNURL rails registered, so `route()` accepts a
 *  Lightning address. Separate from {@link arkadeLnurl}: paying needs no address
 *  of your own, and so no server. */
export function arkadePaymentRouter(opts: {
  wallet: Wallet;
  lightning?: PaymentRail;
  client?: LnurlClient;
  comment?: string;
}): PaymentRouter {
  const router = createDefaultPaymentRouter(opts.wallet);
  if (opts.lightning) router.use(opts.lightning);
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

export function arkadeLnurl(opts: ArkadeLnurlOptions): ArkadeLnurl {
  const { wallet, baseUrl } = opts;
  const domain = opts.domain ?? new URL(baseUrl).hostname;
  const client = opts.client ?? createLnurlClient({ baseUrl });
  // A client per target, never this one: a client is pinned to one baseUrl, so
  // sharing it would send this server's bearer token to another.
  const payer = createLnurlClient();

  let tokenOnce: Promise<string> | undefined;
  const token = (): Promise<string> => (tokenOnce ??= deriveSessionTokenForIdentity(wallet.identity, domain));

  let routerOnce: PaymentRouter | undefined;
  const router = (): PaymentRouter => (routerOnce ??= arkadePaymentRouter({
    wallet,
    client: payer,
    ...(opts.lightningRail ? { lightning: opts.lightningRail } : {}),
  }));

  const needStore = (): PaymentSyncStore => {
    if (!opts.store) throw new LnurlError("sync needs a store; pass one to arkadeLnurl");
    return opts.store;
  };

  return {
    token,
    async owned() {
      const mine = await client.listAddresses(await token());
      return mine.find((a) => a.status === "active")?.username ?? mine[0]?.username;
    },
    async claim(username) {
      const held = await token();
      const registered = await client.registerAddress({ token: held, username });
      // Boarding rides along: a later call omitting it leaves the rail unregistered.
      await client.registerArkadeIdentity(
        await arkadeIdentityRequest({
          identity: wallet.identity,
          arkadeAddress: await wallet.getAddress(),
          token: held,
          username: registered.username,
          boardingAddress: await wallet.getBoardingAddress(),
        }),
      );
      return { username: registered.username, lightningAddress: registered.lightningAddress };
    },
    lightningAddress: (username) => `${username.toLowerCase()}@${domain}`,
    lnurl: (username) => encodeLnurl(`${baseUrl}/.well-known/lnurlp/${username.toLowerCase()}`),
    // `resolve` ignores `baseUrl` and sends no token, so one client is enough.
    payRequest(username) {
      return client.resolve(this.lnurl(username));
    },
    async payments(username, listOpts) {
      return client.listPayments(await token(), username, { domain, ...listOpts });
    },
    async sync(username) {
      return syncPayments(
        [{ baseUrl, token: await token(), username, domain }],
        { client: (target) => createLnurlClient({ baseUrl: target }), store: needStore() },
      );
    },
    router,
    options: (target, amountSat, prefs) =>
      router().options({ raw: target.trim(), amount: amountSat }, { priority: DEFAULT_RAIL_PRIORITY, ...prefs }),
  };
}

export type { StoredPayment };
