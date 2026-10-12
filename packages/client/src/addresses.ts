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
  /** Registers a nameless receiver instead; mutually exclusive with `username`/`claimCode`. */
  nameless?: boolean;
}

/** A freshly registered LUD-16 lightning address and how to reach it. */
export interface RegisteredAddress {
  /** The `user@domain` address payers use; null for a nameless receiver. */
  lightningAddress: string | null;
  /** The bech32 LNURL encoding of the payRequest URL. */
  lnurl: string;
  /** Username part of the address; null for a nameless receiver. */
  username: string | null;
  /** The username, or the session id while nameless; changes on upgrade. */
  handle: string;
  /** Domain part of the address. */
  domain: string;
  /** Registration status reported by the server. */
  status: string;
  nameless: boolean;
  sessionLnurl: string | null;
}

/** One address owned by a token, as listed by the server; same nullability as `RegisteredAddress`. */
export interface AddressListEntry {
  username: string | null;
  /** Domain part of the address. */
  domain: string;
  /** Registration status reported by the server. */
  status: string;
  /** Creation timestamp reported by the server. */
  createdAt: number;
  lightningAddress: string | null;
  /** The bech32 LNURL encoding of the payRequest URL. */
  lnurl: string;
  handle: string;
  nameless: boolean;
  /** Survives a later upgrade to a name. */
  sessionLnurl: string | null;
}

/** What a domain allows, discoverable before calling any of its routes. */
export interface DomainCapabilities {
  domain: string;
  allocationModes: string[];
  usernameRules: { minLen: number; maxLen: number; pattern: string };
  requireApiKey: boolean;
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
  /** Handle of the already-registered address. */
  handle: string;
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

/** A server predating nameless receivers omits these; every row it has is named. */
const asRegistered = (a: RegisteredAddress): RegisteredAddress => ({
  ...a, handle: a.handle ?? a.username!, nameless: a.nameless ?? false, sessionLnurl: a.sessionLnurl ?? null,
});
const asListed = (a: AddressListEntry): AddressListEntry => ({
  ...a, handle: a.handle ?? a.username!, nameless: a.nameless ?? false, sessionLnurl: a.sessionLnurl ?? null,
});

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
  const body: Record<string, string | boolean> = { token: req.token };
  if (req.username !== undefined) body["username"] = req.username;
  if (req.claimCode !== undefined) body["claimCode"] = req.claimCode;
  if (req.domain !== undefined) body["domain"] = req.domain;
  if (req.nameless !== undefined) body["nameless"] = req.nameless;
  return apiFetch<RegisteredAddress>(`${rootOf(baseUrl)}/lnurl/address`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }, fetchImpl).then(asRegistered);
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
  }, fetchImpl).then((entries) => entries.map(asListed));
}

/** Upgrades a nameless receiver in place to a named one; everything handed out while nameless keeps working. */
export function upgradeAddress(
  baseUrl: string,
  req: { token: string; handle: string; username?: string; claimCode?: string; domain?: string },
  fetchImpl: FetchImpl,
): Promise<RegisteredAddress> {
  const body: Record<string, string> = {};
  if (req.username !== undefined) body["username"] = req.username;
  if (req.claimCode !== undefined) body["claimCode"] = req.claimCode;
  const query = req.domain !== undefined ? `?domain=${encodeURIComponent(req.domain)}` : "";
  return apiFetch<RegisteredAddress>(`${rootOf(baseUrl)}/lnurl/address/${encodeURIComponent(req.handle)}${query}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", Authorization: `Bearer ${req.token}` },
    body: JSON.stringify(body),
  }, fetchImpl).then(asRegistered);
}

export function domainCapabilities(
  baseUrl: string,
  opts: { domain?: string } | undefined,
  fetchImpl: FetchImpl,
): Promise<DomainCapabilities> {
  const query = opts?.domain !== undefined ? `?domain=${encodeURIComponent(opts.domain)}` : "";
  return apiFetch<DomainCapabilities>(`${rootOf(baseUrl)}/lnurl/domain${query}`, undefined, fetchImpl);
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
 * @param handle - Handle of the address whose payments to list.
 * @param opts - Optional domain, inclusive since cursor and page limit.
 * @param fetchImpl - The injected `fetch` implementation to call.
 * @returns The payment page with rail-discriminated activity entries.
 */
export async function listPayments(
  baseUrl: string,
  token: string,
  handle: string,
  opts: { domain?: string; since?: number; limit?: number } | undefined,
  fetchImpl: FetchImpl,
): Promise<PaymentPage> {
  const params = new URLSearchParams();
  if (opts?.domain !== undefined) params.set("domain", opts.domain);
  if (opts?.since !== undefined) params.set("since", String(opts.since));
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  const query = params.size > 0 ? `?${params.toString()}` : "";
  const page = await apiFetch<{ source: PaymentPage["source"]; payments: AddressPaymentRow[]; nextSince: number }>(
    `${rootOf(baseUrl)}/lnurl/address/${encodeURIComponent(handle)}/payments${query}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
    fetchImpl,
  );
  return {
    source: { ...page.source, handle: page.source.handle ?? handle },
    payments: page.payments.map(toActivity),
    nextSince: page.nextSince,
  };
}

/**
 * Revokes one address owned by a token.
 *
 * @param baseUrl - Server root, e.g. `https://lnurl.example.com`.
 * @param token - Token owning the address; sent as the Bearer credential.
 * @param handle - Handle of the address to revoke.
 * @param opts - Optional domain scoping the revocation.
 * @param fetchImpl - The injected `fetch` implementation to call.
 * @returns A promise settling when the server revokes the address.
 */
export async function revokeAddress(
  baseUrl: string,
  token: string,
  handle: string,
  opts: { domain?: string } | undefined,
  fetchImpl: FetchImpl,
): Promise<void> {
  const query = opts?.domain !== undefined ? `?domain=${encodeURIComponent(opts.domain)}` : "";
  await apiFetch<unknown>(`${rootOf(baseUrl)}/lnurl/address/${encodeURIComponent(handle)}${query}`, {
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
 * @param req - Token, handle, Arkade address, claim key, optional boarding address and domain.
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
  await apiFetch<unknown>(`${rootOf(baseUrl)}/lnurl/address/${encodeURIComponent(req.handle)}/arkade`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${req.token}` },
    body: JSON.stringify(body),
  }, fetchImpl);
}
