import { LnurlError, LnurlTransportError, LnurlTimeoutError } from "./errors.js";
import type { FetchImpl } from "./http.js";
import { resolve, requestInvoice, pollVerify } from "./payer.js";
import { openSession } from "./session.js";
import type { InvoiceResponder, LnurlSession, OpenSessionOptions, SessionHandlers } from "./session.js";
import { deriveSessionToken, deriveSessionTokenWithSigner, deriveSessionId } from "./token.js";
// Exported because a consumer validates user input before it has a client:
// the wallet's send form and its tests need isValidLnUrl on its own.
import { isLnAddress, isLnUrl, isValidLnUrl, toPayRequestUrl } from "./encoding.js";
import type { LnurlSurface } from "./encoding.js";
import {
  assertCovenantSupplyAccepted,
  fetchCovenantRecovery,
  fetchSwapRecovery,
  listAddresses,
  listPayments,
  registerAddress,
  registerArkadeIdentity,
  revokeAddress,
} from "./addresses.js";
import { syncPayments } from "./sync.js";
import type { PaymentSyncStore, PaymentSyncTarget, StoredPayment } from "./sync.js";
import type {
  AddressListEntry,
  ArkadeIdentityResult,
  CovenantDestinationRecord,
  CovenantProfile,
  CovenantRecovery,
  CovenantSupplyAck,
  CovenantSupplyRequest,
  RegisterAddressRequest,
  RegisterArkadeIdentityRequest,
  RegisteredAddress,
  SwapRecoveryRecord,
  SwapSupplyAck,
  SwapSupplyRequest,
} from "./addresses.js";
import type {
  AmountObject,
  Bolt11Activity,
  Bolt11Result,
  Bolt11VerifyStatus,
  DestinationActivity,
  DestinationResult,
  DestinationVerifyStatus,
  InvoiceResult,
  PayRequest,
  PaymentActivity,
  PaymentOption,
  PaymentPage,
  PaymentQuote,
  PollVerifyOptions,
  RequestInvoiceOptions,
  Unit,
  VerifyStatus,
} from "./types.js";

/**
 * Options for `createLnurlClient`. Everything is optional: payer-only
 * callers omit `baseUrl` entirely and inject nothing when the global `fetch`
 * will do.
 */
export interface LnurlClientOptions {
  /**
   * Server root, needed ONLY for receiver/management calls (`openSession`,
   * `registerAddress`, `listAddresses`, `revokeAddress`,
   * `registerArkadeIdentity`). The payer surface is host-agnostic — an
   * address resolves against its own domain and a bech32 LNURL against its
   * decoded URL — so `createLnurlClient()` with no argument is valid for
   * payer-only use. Those methods throw `LnurlError` when it is missing.
   */
  baseUrl?: string;
  /**
   * `fetch` implementation to call. Defaults to resolving `globalThis.fetch`
   * per call, not once at construction, so a client built at module scope
   * still sees a fetch installed later (mock, polyfill, service worker).
   */
  fetchImpl?: FetchImpl;
}

/**
 * The single facade both roles use: host-agnostic payer calls plus
 * `baseUrl`-bound receiver/management calls sharing one `fetch`.
 */
export interface LnurlClient {
  /**
   * Fetches the payRequest for a lightning address or bech32 LNURL.
   *
   * @param input - A lightning address or bech32 LNURL.
   * @returns The payRequest with its fetch source attached.
   */
  resolve(input: string): Promise<PayRequest>;
  /**
   * Asks the payRequest callback for an invoice or payment destination.
   *
   * @param payRequest - The payRequest from `resolve`.
   * @param opts - `amountSat` plus optional comment, rail and unit selection.
   * @returns A BOLT11 invoice or a destination to pay on the selected rail.
   */
  requestInvoice(payRequest: PayRequest, opts: RequestInvoiceOptions): Promise<InvoiceResult>;
  /**
   * Polls a verify URL until the payment settles, the deadline passes, or the
   * caller aborts.
   *
   * @param verifyUrl - The verify URL from the invoice result.
   * @param opts - Optional interval, timeout, per-poll callback and abort signal.
   * @returns The settled verify status.
   */
  pollVerify(verifyUrl: string, opts?: PollVerifyOptions): Promise<VerifyStatus>;
  /**
   * Opens a receiver session as POST-SSE; resolves on `session_created`.
   * Requires `baseUrl`.
   *
   * @param opts - Optional token, abort signal and reconnect policy.
   * @param handlers - Invoice, settlement, error and reconnect callbacks.
   * @returns The opened session once `session_created` arrives.
   */
  openSession(opts: OpenSessionOptions, handlers: SessionHandlers): Promise<LnurlSession>;
  /**
   * Registers a LUD-16 lightning address. Requires `baseUrl`.
   *
   * @param req - Token, optional username/claimCode/domain, and optional API key.
   * @returns The registered address and how to reach it.
   */
  registerAddress(req: RegisterAddressRequest): Promise<RegisteredAddress>;
  /**
   * Lists the LUD-16 addresses owned by a token. Requires `baseUrl`.
   *
   * @param token - Token whose addresses to list.
   * @returns The addresses owned by the token.
   */
  listAddresses(token: string): Promise<AddressListEntry[]>;
  /**
   * Revokes one address owned by a token. Requires `baseUrl`.
   *
   * @param token - Token owning the address.
   * @param username - Username of the address to revoke.
   * @param opts - Optional domain scoping the revocation.
   * @returns A promise settling when the server revokes the address.
   */
  revokeAddress(token: string, username: string, opts?: { domain?: string }): Promise<void>;
  /**
   * Binds an Arkade identity to a registered address. Requires `baseUrl`.
   *
   * An absent `covenantSupply` in the result means the supply was NOT stored,
   * including by a server too old to know the field.
   *
   * @param req - Token, username, Arkade address, claim key, optional boarding address, supply and domain.
   * @returns The server's supply acknowledgement, or `{}` when none was sent or stored.
   */
  registerArkadeIdentity(req: RegisterArkadeIdentityRequest): Promise<ArkadeIdentityResult>;
  /**
   * Lists the payments made to one address owned by a token. Requires `baseUrl`.
   *
   * @param token - Token owning the address.
   * @param username - Username of the address whose payments to list.
   * @param opts - Optional domain, inclusive since cursor and page limit.
   * @returns The payment page with rail-discriminated activity entries.
   */
  listPayments(token: string, username: string, opts?: { domain?: string; since?: number; limit?: number }): Promise<PaymentPage>;
}

/**
 * Creates the client both roles share.
 *
 * `baseUrl` is receiver-side state only: the payer surface resolves against
 * the address domain or the decoded LNURL, so payer-only callers pass nothing
 * and only the receiver/management methods demand it. The default `fetch`
 * resolves `globalThis.fetch` per call, not once at construction, so a client
 * built at module scope still sees a fetch installed later.
 *
 * @param opts - Optional `baseUrl` and `fetchImpl`.
 * @returns A client sharing one resolved `fetch` across both roles.
 */
export function createLnurlClient(opts?: LnurlClientOptions): LnurlClient {
  const baseUrl = opts?.baseUrl;
  // Looked up per call, not bound once: a client built at module scope would
  // otherwise capture whatever `fetch` existed at import time, silently ignoring
  // a mock, polyfill or service worker installed later. Called off globalThis so
  // the receiver is right.
  const fetchImpl: FetchImpl = opts?.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const needBase = (method: string): string => {
    if (!baseUrl) throw new LnurlError(`baseUrl is required for ${method}`);
    return baseUrl;
  };
  return {
    resolve: (input) => resolve(input, fetchImpl),
    requestInvoice: (payRequest, reqOpts) => requestInvoice(payRequest, reqOpts, fetchImpl),
    pollVerify: (verifyUrl, pollOpts) => pollVerify(verifyUrl, pollOpts, fetchImpl),
    openSession: async (sessionOpts, handlers) =>
      openSession(needBase("openSession"), sessionOpts, handlers, fetchImpl),
    registerAddress: async (req) =>
      registerAddress(needBase("registerAddress"), req, fetchImpl),
    listAddresses: async (token) =>
      listAddresses(needBase("listAddresses"), token, fetchImpl),
    revokeAddress: async (token, username, revokeOpts) =>
      revokeAddress(needBase("revokeAddress"), token, username, revokeOpts, fetchImpl),
    registerArkadeIdentity: async (req) =>
      registerArkadeIdentity(needBase("registerArkadeIdentity"), req, fetchImpl),
    listPayments: async (token, username, listOpts) =>
      listPayments(needBase("listPayments"), token, username, listOpts, fetchImpl),
  };
}

/** Lower-level functions, also reachable through `createLnurlClient`; documented at their definition sites. */
export {
  assertCovenantSupplyAccepted,
  fetchCovenantRecovery,
  fetchSwapRecovery,
  deriveSessionId,
  deriveSessionToken,
  deriveSessionTokenWithSigner,
  isLnAddress,
  isLnUrl,
  isValidLnUrl,
  toPayRequestUrl,
  listAddresses,
  listPayments,
  LnurlError,
  LnurlTimeoutError,
  LnurlTransportError,
  openSession,
  pollVerify,
  registerAddress,
  registerArkadeIdentity,
  requestInvoice,
  resolve,
  revokeAddress,
  syncPayments,
};
export type {
  AddressListEntry,
  AmountObject,
  ArkadeIdentityResult,
  CovenantDestinationRecord,
  CovenantProfile,
  CovenantRecovery,
  CovenantSupplyAck,
  CovenantSupplyRequest,
  SwapRecoveryRecord,
  SwapSupplyAck,
  SwapSupplyRequest,
  Bolt11Activity,
  Bolt11Result,
  Bolt11VerifyStatus,
  DestinationActivity,
  DestinationResult,
  DestinationVerifyStatus,
  FetchImpl,
  InvoiceResponder,
  InvoiceResult,
  LnurlSession,
  LnurlSurface,
  OpenSessionOptions,
  PayRequest,
  PaymentActivity,
  PaymentOption,
  PaymentPage,
  PaymentQuote,
  PollVerifyOptions,
  RegisterAddressRequest,
  RegisterArkadeIdentityRequest,
  RegisteredAddress,
  PaymentSyncStore,
  PaymentSyncTarget,
  RequestInvoiceOptions,
  StoredPayment,
  SessionHandlers,
  Unit,
  VerifyStatus,
};
