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
import { arkadeIdentityRequest, deriveSessionTokenForIdentity, type ArkadeSigner } from "./arkade.js";
import { LnurlError } from "./errors.js";
import { createLnurlClient, type LnurlClient } from "./index.js";
import { lnurlRails } from "./rail.js";
import { deriveSessionId } from "./token.js";
import { syncPayments, type PaymentSyncStore, type StoredPayment } from "./sync.js";
import type { DomainCapabilities } from "./addresses.js";
import type { PayRequest, PaymentPage } from "./types.js";

/** The 1023 limit is LUD-01's, not bech32's default 90. */
export function encodeLnurl(url: string): string {
  return bech32.encode("lnurl", bech32.toWords(new TextEncoder().encode(url)), 1023).toUpperCase();
}

/** A wallet supplies the signer and both addresses. Without one — a script, a
 *  test, a server holding only a key — name them; only sending needs a wallet. */
export type ArkadeLnurlSource =
  | { wallet: Wallet; identity?: never; arkadeAddress?: never }
  | { wallet?: never; identity: ArkadeSigner; arkadeAddress: string; boardingAddress?: string };

export type ArkadeLnurlOptions = ArkadeLnurlSource & ArkadeLnurlConfig;

export interface ArkadeLnurlConfig {
  baseUrl: string;
  /** Defaults to `baseUrl`'s hostname, as the server derives it: a LUD-16
   *  domain cannot carry a port. */
  domain?: string;
  store?: PaymentSyncStore;
  lightningRail?: PaymentRail;
  client?: LnurlClient;
}

/** A claim code is checked only against the reserved name it unlocks, so it never travels alone. */
export type NameOptions =
  | { username?: string; claimCode?: never }
  | { username: string; claimCode: string };

/** `nameless` is mutually exclusive with `username`/`claimCode` at the type
 *  level, matching the server's 400 `invalid_username` on combining them. */
export type ClaimOptions =
  | (NameOptions & { nameless?: never })
  | { nameless: true; username?: never; claimCode?: never };

/** One claimed or listed address, holding everything scoped to it. */
export interface Receiver {
  readonly handle: string;
  /** `user@domain`; undefined for a nameless receiver. */
  readonly lightningAddress: string | undefined;
  /** For a QR. The session LNURL when flagged (survives {@link upgrade}), else `.well-known`. */
  readonly lnurl: string;
  /** Addressed through `baseUrl`, not the LUD-16 domain, which drops the port. */
  payRequest(): Promise<PayRequest>;
  payments(opts?: { since?: number; limit?: number }): Promise<PaymentPage>;
  sync(): Promise<{ synced: number; failures: unknown[] }>;
  /** Names a nameless receiver in place; everything handed out while nameless
   *  keeps working. Does not re-bind the Arkade identity, already on the row. */
  upgrade(opts?: NameOptions): Promise<Receiver>;
}

export interface ArkadeLnurl {
  /** Derived once; signs twice on the first call, nothing on later ones. */
  token(): Promise<string>;
  capabilities(): Promise<DomainCapabilities>;
  /** Registers an address — named, random or nameless per `opts` — and binds
   *  the identity. Until the bind lands the address advertises no
   *  `paymentOptions` at all, so offline receive does not exist. */
  claim(opts?: ClaimOptions): Promise<Receiver>;
  owned(): Promise<Receiver | undefined>;
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
  const identity = wallet ? wallet.identity : opts.identity;
  const addresses = async () => (wallet
    ? { arkadeAddress: await wallet.getAddress(), boardingAddress: await wallet.getBoardingAddress() }
    : { arkadeAddress: opts.arkadeAddress, ...(opts.boardingAddress ? { boardingAddress: opts.boardingAddress } : {}) });
  const client = opts.client ?? createLnurlClient({ baseUrl });
  // A client per target, never this one: a client is pinned to one baseUrl, so
  // sharing it would send this server's bearer token to another.
  const payer = createLnurlClient();

  let tokenOnce: Promise<string> | undefined;
  const token = (): Promise<string> => (tokenOnce ??= deriveSessionTokenForIdentity(identity, domain));

  let routerOnce: PaymentRouter | undefined;
  const router = (): PaymentRouter => {
    // Receiving needs only a signer; spending the wallet's own coins needs the wallet.
    if (!wallet) throw new LnurlError("paying needs a wallet; arkadeLnurl was given an identity only");
    return (routerOnce ??= arkadePaymentRouter({
      wallet,
      client: payer,
      ...(opts.lightningRail ? { lightning: opts.lightningRail } : {}),
    }));
  };

  const needStore = (): PaymentSyncStore => {
    if (!opts.store) throw new LnurlError("sync needs a store; pass one to arkadeLnurl");
    return opts.store;
  };

  // `flagged` means served at `/lnurl/<sessionId>`; it survives an upgrade,
  // so `upgrade` below carries it through rather than recomputing it. The session
  // id comes from `held`, never from the server's own `sessionLnurl`/`lnurl` bech32:
  // those are built from the LUD-16 domain and would drop `baseUrl`'s port.
  const receiverFrom = (held: string, handle: string, lightningAddress: string | null, flagged: boolean): Receiver => {
    const lnurl = flagged
      ? encodeLnurl(`${baseUrl}/lnurl/${deriveSessionId(held)}`)
      : encodeLnurl(`${baseUrl}/.well-known/lnurlp/${handle}`);
    return {
      handle,
      lightningAddress: lightningAddress ?? undefined,
      lnurl,
      // `resolve` ignores `baseUrl` and sends no token, so one client is enough.
      payRequest: () => client.resolve(lnurl),
      payments: (listOpts) => client.listPayments(held, handle, { domain, ...listOpts }),
      sync: async () => syncPayments(
        [{ baseUrl, token: held, handle, domain }],
        { client: (target) => createLnurlClient({ baseUrl: target }), store: needStore() },
      ),
      async upgrade(upgradeOpts) {
        const registered = await client.upgradeAddress({ token: held, handle, domain, ...upgradeOpts });
        return receiverFrom(held, registered.handle, registered.lightningAddress, flagged);
      },
    };
  };

  return {
    token,
    capabilities: () => client.domainCapabilities({ domain }),
    async owned() {
      const held = await token();
      const mine = (await client.listAddresses(held)).filter((a) => a.domain.toLowerCase() === domain.toLowerCase());
      const active = mine.filter((a) => a.status === "active");
      const chosen = active.find((a) => a.sessionLnurl !== null) ?? active[0] ?? mine[0];
      return chosen ? receiverFrom(held, chosen.handle, chosen.lightningAddress, chosen.sessionLnurl !== null) : undefined;
    },
    async claim(claimOpts) {
      const held = await token();
      const registered = await client.registerAddress({
        token: held,
        domain,
        ...(claimOpts?.nameless ? { nameless: true as const } : {}),
        ...(claimOpts?.username !== undefined ? { username: claimOpts.username } : {}),
        ...(claimOpts?.claimCode !== undefined ? { claimCode: claimOpts.claimCode } : {}),
      });
      // From the response, not the request: a server predating nameless ignores the flag and allocates a name.
      const flagged = registered.sessionLnurl != null;
      if (claimOpts?.nameless && !flagged) {
        throw new LnurlError(
          `server ignored nameless and registered "${registered.handle}"; it predates nameless receivers — revoke that address if unwanted`,
        );
      }
      // Boarding rides along: a later call omitting it leaves the rail unregistered.
      await client.registerArkadeIdentity(
        await arkadeIdentityRequest({
          identity,
          token: held,
          handle: registered.handle,
          domain,
          ...(await addresses()),
        }),
      );
      return receiverFrom(held, registered.handle, registered.lightningAddress, flagged);
    },
    router,
    options: (target, amountSat, prefs) =>
      router().options({ raw: target.trim(), amount: amountSat }, { priority: DEFAULT_RAIL_PRIORITY, ...prefs }),
  };
}

export type { StoredPayment };
