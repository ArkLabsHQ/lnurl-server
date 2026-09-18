import {
  createLnurlClient,
  syncPayments,
  type InvoiceResult,
  type LnurlClient,
  type PayRequest,
  type PaymentActivity,
  type PaymentSyncStore,
  type VerifyStatus,
} from "@arkade-os/lnurl-client";
import { arkadeIdentityRequest, deriveSessionTokenForIdentity, type ArkadeSigner } from "@arkade-os/lnurl-client/arkade";
import { LNURL_BASE, LNURL_DOMAIN } from "./config.js";

export interface Onboarded {
  token: string;
  username: string;
  lightningAddress: string;
  lnurl: string;
}

/**
 * The server-bound half of the wallet.
 *
 * A factory rather than a module-level client because both the token and the
 * bearer credential are scoped to one domain: sharing one client across servers
 * would send a token minted for one host to another.
 */
export interface LnurlApi {
  /**
   * The credential for every receiver call, bound to this domain.
   *
   * Always via this helper: it pins ECDSA, while `signMessage` defaults to
   * randomised schnorr of the same 64-byte length — which would mint a fresh
   * token per call and silently orphan the registered address.
   */
  deriveToken(identity: ArkadeSigner): Promise<string>;
  /**
   * Claims a username, then binds the Arkade identity to it.
   *
   * Order is load-bearing twice over: the bind names a username that must
   * already exist, and until it lands the payRequest advertises no
   * `paymentOptions` at all, so offline receive does not exist for this address.
   */
  onboard(
    identity: ArkadeSigner,
    arkadeAddress: string,
    username: string,
    boardingAddress?: string,
  ): Promise<Onboarded>;
  /**
   * The username this token already owns, if any.
   *
   * What makes a restored phrase usable on a new device: the server refuses to
   * re-register a username that exists, even to its rightful owner
   * (`address-service.ts` throws `taken` before it looks at ownership), so a
   * wallet that has lost its local state must ask rather than re-claim.
   */
  ownedUsername(token: string): Promise<string | undefined>;
  payments(token: string, username: string): Promise<PaymentActivity[]>;
  /**
   * Pulls payment activity into a local store, resuming from the cursor it
   * wrote last time.
   *
   * Preferred over `payments`, which re-fetches one page every poll and keeps
   * nothing: the receive rails complete while the wallet is closed, so the
   * payments it most needs are exactly the ones it was not there for.
   */
  syncActivity(token: string, username: string, store: PaymentSyncStore): Promise<{ synced: number; failures: unknown[] }>;
  /**
   * Polls a verify URL until the receiver reports the payment settled.
   *
   * Only some rails hand one out: a covenant destination and a bolt11 do, a
   * static destination does not, because one address reused for every payment
   * cannot say which one settled. A caller must treat absence as "no answer
   * available", not as failure.
   */
  pollVerify(verifyUrl: string, opts?: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal }): Promise<VerifyStatus>;
  resolveTarget(input: string): Promise<PayRequest>;
  requestPayment(
    payRequest: PayRequest,
    amountSat: number,
    paymentOption: string | undefined,
    comment?: string,
  ): Promise<InvoiceResult>;
}

export function createLnurlApi(baseUrl: string, domain: string, client: LnurlClient = createLnurlClient({ baseUrl })): LnurlApi {
  const deriveToken = (identity: ArkadeSigner) => deriveSessionTokenForIdentity(identity, domain);
  return {
    deriveToken,
    async onboard(identity, arkadeAddress, username, boardingAddress) {
      const token = await deriveToken(identity);
      const registered = await client.registerAddress({ token, username });
      // The boarding address rides along so the onchain rail exists from the
      // first payRequest; a second call omitting it would leave the rail alone
      // rather than register it, so this is the moment to send it.
      await client.registerArkadeIdentity(
        await arkadeIdentityRequest({
          identity,
          arkadeAddress,
          token,
          username: registered.username,
          ...(boardingAddress !== undefined ? { boardingAddress } : {}),
        }),
      );
      return {
        token,
        username: registered.username,
        lightningAddress: registered.lightningAddress,
        lnurl: registered.lnurl,
      };
    },
    async ownedUsername(token) {
      const mine = await client.listAddresses(token);
      return mine.find((a) => a.status === "active")?.username ?? mine[0]?.username;
    },
    async payments(token, username) {
      const page = await client.listPayments(token, username, { limit: 50 });
      return page.payments;
    },
    async syncActivity(token, username, store) {
      // A factory, not the shared client: a client is pinned to one baseUrl, so
      // reusing this one across targets would send this server's token to another.
      const { synced, failures } = await syncPayments(
        [{ baseUrl, token, username, domain }],
        { client: (target) => createLnurlClient({ baseUrl: target }), store },
      );
      return { synced, failures };
    },
    resolveTarget: (input) => client.resolve(input.trim()),
    pollVerify: (verifyUrl, opts) => client.pollVerify(verifyUrl, opts),
    requestPayment: (payRequest, amountSat, paymentOption, comment) =>
      client.requestInvoice(payRequest, {
        amountSat,
        ...(paymentOption ? { paymentOption } : {}),
        ...(comment ? { comment } : {}),
      }),
  };
}

/** The instance the app uses. */
export const lnurl = createLnurlApi(LNURL_BASE, LNURL_DOMAIN);
