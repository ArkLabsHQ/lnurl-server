import { LnurlError, LnurlTransportError, LnurlTimeoutError } from "./errors.js";
import type { FetchImpl } from "./http.js";
import { resolve, requestInvoice, pollVerify } from "./payer.js";
import { openSession } from "./session.js";
import type { InvoiceResponder, LnurlSession, OpenSessionOptions, SessionHandlers } from "./session.js";
import { deriveSessionToken, deriveSessionId } from "./token.js";
// Exported because a consumer validates user input before it has a client:
// the wallet's send form and its tests need isValidLnUrl on its own.
import { isLnAddress, isLnUrl, isValidLnUrl, toPayRequestUrl } from "./encoding.js";
import type { LnurlSurface } from "./encoding.js";
import { listAddresses, registerAddress, registerArkadeIdentity, revokeAddress } from "./addresses.js";
import type {
  AddressListEntry,
  RegisterAddressRequest,
  RegisterArkadeIdentityRequest,
  RegisteredAddress,
} from "./addresses.js";
import type {
  AmountObject,
  Bolt11Result,
  Bolt11VerifyStatus,
  DestinationResult,
  DestinationVerifyStatus,
  InvoiceResult,
  PayRequest,
  PaymentOption,
  PaymentQuote,
  PollVerifyOptions,
  RequestInvoiceOptions,
  Unit,
  VerifyStatus,
} from "./types.js";

export interface LnurlClientOptions {
  baseUrl?: string;
  fetchImpl?: FetchImpl;
}

export interface LnurlClient {
  resolve(input: string): Promise<PayRequest>;
  requestInvoice(payRequest: PayRequest, opts: RequestInvoiceOptions): Promise<InvoiceResult>;
  pollVerify(verifyUrl: string, opts?: PollVerifyOptions): Promise<VerifyStatus>;
  openSession(opts: OpenSessionOptions, handlers: SessionHandlers): Promise<LnurlSession>;
  registerAddress(req: RegisterAddressRequest): Promise<RegisteredAddress>;
  listAddresses(token: string): Promise<AddressListEntry[]>;
  revokeAddress(token: string, username: string, opts?: { domain?: string }): Promise<void>;
  registerArkadeIdentity(req: RegisterArkadeIdentityRequest): Promise<void>;
}

export function createLnurlClient(opts?: LnurlClientOptions): LnurlClient {
  const baseUrl = opts?.baseUrl;
  // Bound so a destructured global fetch still sends with the right receiver.
  const fetchImpl: FetchImpl = opts?.fetchImpl ?? globalThis.fetch.bind(globalThis);
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
  };
}

export {
  deriveSessionId,
  deriveSessionToken,
  isLnAddress,
  isLnUrl,
  isValidLnUrl,
  toPayRequestUrl,
  listAddresses,
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
};
export type {
  AddressListEntry,
  AmountObject,
  Bolt11Result,
  Bolt11VerifyStatus,
  DestinationResult,
  DestinationVerifyStatus,
  FetchImpl,
  InvoiceResponder,
  InvoiceResult,
  LnurlSession,
  LnurlSurface,
  OpenSessionOptions,
  PayRequest,
  PaymentOption,
  PaymentQuote,
  PollVerifyOptions,
  RegisterAddressRequest,
  RegisterArkadeIdentityRequest,
  RegisteredAddress,
  RequestInvoiceOptions,
  SessionHandlers,
  Unit,
  VerifyStatus,
};