import { apiFetch, type FetchImpl } from "./http.js";
import type { Bolt11Activity, DestinationActivity, PaymentActivity, PaymentPage } from "./types.js";
import { LnurlError } from "./errors.js";

/**
 * What registering a LUD-16 lightning address needs. `token` owns the
 * address: the server derives the session id from it and keys ownership off
 * that id, so the same token lists and revokes what it registered.
 */
export interface RegisterAddressRequest {
  /** Token owning the address; doubles as the Bearer credential. */
  token: string;
  /** Desired username; server-assigned when omitted. */
  username?: string;
  /** Claim code binding the registration, on domains that issue one. */
  claimCode?: string;
  /** Receiving domain; the server default when omitted. */
  domain?: string;
  /** Sent as `X-API-Key` on domains that require one. */
  apiKey?: string;
}

/** A freshly registered LUD-16 lightning address and how to reach it. */
export interface RegisteredAddress {
  /** The `user@domain` address payers use. */
  lightningAddress: string;
  /** The bech32 LNURL encoding of the payRequest URL. */
  lnurl: string;
  /** Username part of the address. */
  username: string;
  /** Domain part of the address. */
  domain: string;
  /** Registration status reported by the server. */
  status: string;
}

/** One address owned by a token, as listed by the server. */
export interface AddressListEntry {
  /** Username part of the address. */
  username: string;
  /** Domain part of the address. */
  domain: string;
  /** Registration status reported by the server. */
  status: string;
  /** Creation timestamp reported by the server. */
  createdAt: number;
  /** The `user@domain` address payers use. */
  lightningAddress: string;
  /** The bech32 LNURL encoding of the payRequest URL. */
  lnurl: string;
}

/**
 * What binding an Arkade identity to an address needs. `claimPublicKey` must
 * be a compressed 33-byte key and is checked locally; the Arkade address
 * itself is NOT validated client-side because that would need the SDK, which
 * is deliberately not a dependency.
 */
export interface RegisterArkadeIdentityRequest {
  /** Token owning the address; sent as the Bearer credential. */
  token: string;
  /** Username of the already-registered address. */
  username: string;
  /** Arkade address receiving offline payments; validated server-side. */
  arkadeAddress: string;
  /** Compressed 33-byte public key: `02`/`03` prefix plus 64 hex chars. */
  claimPublicKey: string;
  /** Boarding address the onchain rail pays; omit it to leave a registered one alone. */
  boardingAddress?: string;
  /** Receiving domain; the server default when omitted. */
  domain?: string;
}

function rootOf(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Registers a LUD-16 lightning address owned by `req.token`.
 *
 * @param baseUrl - Server root, e.g. `https://lnurl.example.com`.
 * @param req - Token, optional username/claimCode/domain, and optional API key.
 * @param fetchImpl - The injected `fetch` implementation to call.
 * @returns The registered address and how to reach it.
 */
export function registerAddress(
  baseUrl: string,
  req: RegisterAddressRequest,
  fetchImpl: FetchImpl,
): Promise<RegisteredAddress> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (req.apiKey !== undefined) headers["X-API-Key"] = req.apiKey;
  const body: Record<string, string> = { token: req.token };
  if (req.username !== undefined) body["username"] = req.username;
  if (req.claimCode !== undefined) body["claimCode"] = req.claimCode;
  if (req.domain !== undefined) body["domain"] = req.domain;
  return apiFetch<RegisteredAddress>(`${rootOf(baseUrl)}/lnurl/address`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }, fetchImpl);
}

/**
 * Lists the LUD-16 addresses owned by a token.
 *
 * @param baseUrl - Server root, e.g. `https://lnurl.example.com`.
 * @param token - Token whose addresses to list; sent as the Bearer credential.
 * @param fetchImpl - The injected `fetch` implementation to call.
 * @returns The addresses owned by the token.
 */
export function listAddresses(
  baseUrl: string,
  token: string,
  fetchImpl: FetchImpl,
): Promise<AddressListEntry[]> {
  return apiFetch<AddressListEntry[]>(`${rootOf(baseUrl)}/lnurl/address`, {
    headers: { Authorization: `Bearer ${token}` },
  }, fetchImpl);
}

/** One settlement row as the payments route serves it. */
interface AddressPaymentRow {
  paymentHash: string;
  pr: string;
  preimage: string | null;
  swapId: string | null;
  paymentOption: string;
  paymentDestination: string | null;
  covenantScript: string | null;
  paymentReference: string | null;
  payoutReference: string | null;
  settled: boolean;
  amountMsat: number | null;
  createdAt: number;
  settledAt: number | null;
}

function toActivity(row: AddressPaymentRow): PaymentActivity {
  // The rail tag decides, like parseVerifyStatus in payer.ts: "lightning" is
  // a real BOLT11 hash, anything else is an opaque destination verify id.
  if (row.paymentOption === "lightning") {
    const activity: Bolt11Activity = {
      kind: "bolt11",
      paymentHash: row.paymentHash,
      pr: row.pr,
      preimage: row.preimage,
      swapId: row.swapId,
      payoutReference: row.payoutReference ?? null,
      settled: row.settled,
      amountMsat: row.amountMsat,
      createdAt: row.createdAt,
      settledAt: row.settledAt,
    };
    return activity;
  }
  const activity: DestinationActivity = {
    kind: "destination",
    verifyId: row.paymentHash,
    paymentOption: row.paymentOption,
    paymentDestination: row.paymentDestination,
    covenantScript: row.covenantScript,
    paymentReference: row.paymentReference,
    payoutReference: row.payoutReference ?? null,
    settled: row.settled,
    amountMsat: row.amountMsat,
    createdAt: row.createdAt,
    settledAt: row.settledAt,
  };
  return activity;
}

/**
 * Lists the payments made to one address owned by a token, oldest first.
 *
 * @param baseUrl - Server root, e.g. `https://lnurl.example.com`.
 * @param token - Token owning the address; sent as the Bearer credential.
 * @param username - Username of the address whose payments to list.
 * @param opts - Optional domain, inclusive since cursor and page limit.
 * @param fetchImpl - The injected `fetch` implementation to call.
 * @returns The payment page with rail-discriminated activity entries.
 */
export async function listPayments(
  baseUrl: string,
  token: string,
  username: string,
  opts: { domain?: string; since?: number; limit?: number } | undefined,
  fetchImpl: FetchImpl,
): Promise<PaymentPage> {
  const params = new URLSearchParams();
  if (opts?.domain !== undefined) params.set("domain", opts.domain);
  if (opts?.since !== undefined) params.set("since", String(opts.since));
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  const query = params.size > 0 ? `?${params.toString()}` : "";
  const page = await apiFetch<{ source: PaymentPage["source"]; payments: AddressPaymentRow[]; nextSince: number }>(
    `${rootOf(baseUrl)}/lnurl/address/${encodeURIComponent(username)}/payments${query}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
    fetchImpl,
  );
  return { source: page.source, payments: page.payments.map(toActivity), nextSince: page.nextSince };
}

/**
 * Revokes one address owned by a token.
 *
 * @param baseUrl - Server root, e.g. `https://lnurl.example.com`.
 * @param token - Token owning the address; sent as the Bearer credential.
 * @param username - Username of the address to revoke.
 * @param opts - Optional domain scoping the revocation.
 * @param fetchImpl - The injected `fetch` implementation to call.
 * @returns A promise settling when the server revokes the address.
 */
export async function revokeAddress(
  baseUrl: string,
  token: string,
  username: string,
  opts: { domain?: string } | undefined,
  fetchImpl: FetchImpl,
): Promise<void> {
  const query = opts?.domain !== undefined ? `?domain=${encodeURIComponent(opts.domain)}` : "";
  await apiFetch<unknown>(`${rootOf(baseUrl)}/lnurl/address/${encodeURIComponent(username)}${query}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  }, fetchImpl);
}

const COMPRESSED_KEY = /^0[23][0-9a-f]{64}$/i;

/**
 * Binds an Arkade identity to a registered address for offline receive.
 *
 * `claimPublicKey` must be a compressed 33-byte key and is rejected locally
 * before any network call; the Arkade address itself is NOT validated
 * client-side because that would need the SDK, which is deliberately not a
 * dependency, so a malformed one fails server-side instead.
 *
 * `boardingAddress` is unvalidated for a stronger reason — it is a Bitcoin
 * address on the operator's network, which this package cannot know — and
 * omitting it sends no field, read server-side as "leave the onchain rail".
 *
 * @param baseUrl - Server root, e.g. `https://lnurl.example.com`.
 * @param req - Token, username, Arkade address, claim key, optional boarding address and domain.
 * @param fetchImpl - The injected `fetch` implementation to call.
 * @returns A promise settling when the server records the identity.
 */
export async function registerArkadeIdentity(
  baseUrl: string,
  req: RegisterArkadeIdentityRequest,
  fetchImpl: FetchImpl,
): Promise<void> {
  // Free to check locally and it is the covenant receiver role; the Arkade
  // address itself is left to the server, validating it needs @arkade-os/sdk.
  if (!COMPRESSED_KEY.test(req.claimPublicKey)) {
    throw new LnurlError("claimPublicKey must be a compressed 33-byte public key (02/03 prefix plus 64 hex chars)");
  }
  const body: Record<string, string> = { arkadeAddress: req.arkadeAddress, claimPublicKey: req.claimPublicKey };
  if (req.boardingAddress !== undefined) body["boardingAddress"] = req.boardingAddress;
  if (req.domain !== undefined) body["domain"] = req.domain;
  await apiFetch<unknown>(`${rootOf(baseUrl)}/lnurl/address/${encodeURIComponent(req.username)}/arkade`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${req.token}` },
    body: JSON.stringify(body),
  }, fetchImpl);
}
