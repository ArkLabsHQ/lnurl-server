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
  /** Preimages the server spends on this address's covenant destinations, so the
   *  owner can rebuild them without it. Omit to leave an existing supply alone. */
  covenantSupply?: CovenantSupplyRequest;
  /** The offline-swap rail's own supply, SEPARATE from `covenantSupply`: one
   *  shared secret would let a reveal on either rail unlock the other. */
  swapSupply?: SwapSupplyRequest;
  /** Receiving domain; the server default when omitted. */
  domain?: string;
}

/** Operator terms a supply is minted against. The server refuses one whose
 *  profile disagrees with its own — different terms, different script. */
export interface CovenantProfile {
  recoveryDelaySeconds: number;
  emulatorPubkey: string;
}

/** One batch of 32-byte-hex preimages plus the terms it was minted under.
 *  `startIndex` must equal the server's reported `nextIndex`; a gap is refused. */
export interface CovenantSupplyRequest {
  scheme: string;
  startIndex: number;
  preimages: string[];
  profile: CovenantProfile;
}

/** No profile: no covenant config enters a solver's VHTLC. */
export interface SwapSupplyRequest {
  scheme: string;
  startIndex: number;
  preimages: string[];
}

/** What the server reports about a supply it stored. */
export interface CovenantSupplyAck {
  accepted: true;
  nextIndex: number;
  remaining: number;
  scheme: string;
  profile: CovenantProfile;
}

export interface SwapSupplyAck {
  accepted: true;
  nextIndex: number;
  remaining: number;
  scheme: string;
}

/** Each field is present only when that supply was sent AND stored. */
export interface ArkadeIdentityResult {
  covenantSupply?: CovenantSupplyAck;
  swapSupply?: SwapSupplyAck;
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

/** One covenant destination and what rebuilds it. `covenantIndex` is null when
 *  the preimage was random: no seed reproduces those, so `params` is the copy. */
export interface CovenantDestinationRecord {
  verifyId: string;
  address: string | null;
  covenantScript: string;
  covenantIndex: number | null;
  params: Record<string, string> | null;
  createdAt: number;
}

export interface CovenantRecovery {
  scheme: string | null;
  profile: CovenantProfile | null;
  destinations: CovenantDestinationRecord[];
}

/** One offline swap plus the blob that makes it claimable without the server.
 *  `swapIndex` is a SWAP-supply slot, never the covenant's. */
export interface SwapRecoveryRecord {
  paymentHash: string;
  preimage: string;
  swapIndex: number | null;
  settled: boolean;
  createdAt: number;
  recovery: unknown;
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
 * **If you sent `covenantSupply`, check the result.** A server older than the
 * supply protocol drops the unknown field and still answers `{ok:true}`, so an
 * absent `covenantSupply` in the result means NOT accepted.
 *
 * @returns The supply acknowledgement, or `{}` when none was sent or stored.
 */
export async function registerArkadeIdentity(
  baseUrl: string,
  req: RegisterArkadeIdentityRequest,
  fetchImpl: FetchImpl,
): Promise<ArkadeIdentityResult> {
  // Free to check locally and it is the covenant receiver role; the Arkade
  // address itself is left to the server, validating it needs @arkade-os/sdk.
  if (!COMPRESSED_KEY.test(req.claimPublicKey)) {
    throw new LnurlError("claimPublicKey must be a compressed 33-byte public key (02/03 prefix plus 64 hex chars)");
  }
  const body: Record<string, unknown> = { arkadeAddress: req.arkadeAddress, claimPublicKey: req.claimPublicKey };
  if (req.boardingAddress !== undefined) body["boardingAddress"] = req.boardingAddress;
  if (req.covenantSupply !== undefined) body["covenantSupply"] = req.covenantSupply;
  if (req.swapSupply !== undefined) body["swapSupply"] = req.swapSupply;
  if (req.domain !== undefined) body["domain"] = req.domain;
  const res = await apiFetch<{ covenantSupply?: CovenantSupplyAck; swapSupply?: SwapSupplyAck }>(
    `${rootOf(baseUrl)}/lnurl/address/${encodeURIComponent(req.username)}/arkade`,
    {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${req.token}` },
      body: JSON.stringify(body),
    },
    fetchImpl,
  );
  return {
    ...(res?.covenantSupply?.accepted === true ? { covenantSupply: res.covenantSupply } : {}),
    ...(res?.swapSupply?.accepted === true ? { swapSupply: res.swapSupply } : {}),
  };
}

/** Throws unless the server actually stored the supply that was sent. Gate on
 *  this, not on the absence of an error: an old server drops an unknown body
 *  field and still answers `{ok:true}`. */
export function assertCovenantSupplyAccepted(
  result: ArkadeIdentityResult,
  sent: CovenantSupplyRequest | undefined,
): CovenantSupplyAck {
  if (!sent) throw new LnurlError("no covenant supply was sent");
  const ack = result.covenantSupply;
  if (!ack) {
    throw new LnurlError(
      "the server did not acknowledge the covenant supply — it is likely older than the supply protocol and dropped the field. " +
        "Destinations it hands out are NOT recoverable from your seed.",
    );
  }
  if (ack.scheme !== sent.scheme) {
    throw new LnurlError(`the server stored the supply under scheme "${ack.scheme}", not "${sent.scheme}"`);
  }
  if (ack.nextIndex !== sent.startIndex + sent.preimages.length) {
    throw new LnurlError(
      `the server reports nextIndex ${ack.nextIndex}, not the ${sent.startIndex + sent.preimages.length} this batch ends at`,
    );
  }
  return ack;
}

/** Every covenant destination on one owned address, with its rebuild params.
 *  Pull it while the server is reachable: destinations minted before any supply
 *  existed carry a random preimage no seed reproduces, so `params` is the only
 *  copy of what spends them. */
export function fetchCovenantRecovery(
  baseUrl: string,
  token: string,
  username: string,
  opts: { domain?: string } | undefined,
  fetchImpl: FetchImpl,
): Promise<CovenantRecovery> {
  const query = opts?.domain !== undefined ? `?domain=${encodeURIComponent(opts.domain)}` : "";
  return apiFetch<CovenantRecovery>(
    `${rootOf(baseUrl)}/lnurl/address/${encodeURIComponent(username)}/covenant-recovery${query}`,
    { headers: { Authorization: `Bearer ${token}` } },
    fetchImpl,
  );
}

/** The recovery blob for every offline swap on one owned address. A derivable
 *  swap preimage is not enough on its own — the VHTLC's script params come from
 *  the solver's quote, which only the server stored. */
export async function fetchSwapRecovery(
  baseUrl: string,
  token: string,
  username: string,
  opts: { domain?: string } | undefined,
  fetchImpl: FetchImpl,
): Promise<SwapRecoveryRecord[]> {
  const query = opts?.domain !== undefined ? `?domain=${encodeURIComponent(opts.domain)}` : "";
  const page = await apiFetch<{ swaps: SwapRecoveryRecord[] }>(
    `${rootOf(baseUrl)}/lnurl/address/${encodeURIComponent(username)}/swap-recovery${query}`,
    { headers: { Authorization: `Bearer ${token}` } },
    fetchImpl,
  );
  return page.swaps;
}
