import { apiFetch, type FetchImpl } from "./http.js";
import { LnurlError } from "./errors.js";

export interface RegisterAddressRequest {
  token: string;
  username?: string;
  claimCode?: string;
  domain?: string;
  apiKey?: string;
}

export interface RegisteredAddress {
  lightningAddress: string;
  lnurl: string;
  username: string;
  domain: string;
  status: string;
}

export interface AddressListEntry {
  username: string;
  domain: string;
  status: string;
  createdAt: number;
  lightningAddress: string;
  lnurl: string;
}

export interface RegisterArkadeIdentityRequest {
  token: string;
  username: string;
  arkadeAddress: string;
  claimPublicKey: string;
  domain?: string;
}

function rootOf(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

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

export function listAddresses(
  baseUrl: string,
  token: string,
  fetchImpl: FetchImpl,
): Promise<AddressListEntry[]> {
  return apiFetch<AddressListEntry[]>(`${rootOf(baseUrl)}/lnurl/address`, {
    headers: { Authorization: `Bearer ${token}` },
  }, fetchImpl);
}

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
  if (req.domain !== undefined) body["domain"] = req.domain;
  await apiFetch<unknown>(`${rootOf(baseUrl)}/lnurl/address/${encodeURIComponent(req.username)}/arkade`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${req.token}` },
    body: JSON.stringify(body),
  }, fetchImpl);
}