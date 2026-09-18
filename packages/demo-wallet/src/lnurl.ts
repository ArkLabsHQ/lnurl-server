import {
  createLnurlClient,
  type InvoiceResult,
  type LnurlClient,
  type PayRequest,
  type PaymentActivity,
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
  onboard(identity: ArkadeSigner, arkadeAddress: string, username: string): Promise<Onboarded>;
  payments(token: string, username: string): Promise<PaymentActivity[]>;
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
    async onboard(identity, arkadeAddress, username) {
      const token = await deriveToken(identity);
      const registered = await client.registerAddress({ token, username });
      await client.registerArkadeIdentity(
        await arkadeIdentityRequest({ identity, arkadeAddress, token, username: registered.username }),
      );
      return {
        token,
        username: registered.username,
        lightningAddress: registered.lightningAddress,
        lnurl: registered.lnurl,
      };
    },
    async payments(token, username) {
      const page = await client.listPayments(token, username, { limit: 50 });
      return page.payments;
    },
    resolveTarget: (input) => client.resolve(input.trim()),
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
