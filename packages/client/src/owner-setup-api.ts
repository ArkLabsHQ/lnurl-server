import { base64urlnopad } from "@scure/base";
import { apiFetch, type FetchImpl } from "./http.js";

/** A signed setup on its way to `POST /lnurl/setup`. Build one with `@arkade-os/lnurl-client/arkade`. */
export interface OwnerSetupSubmission {
  payload: Uint8Array;
  signature: Uint8Array;
  /** The new owner key's signature; required when the setup changes the owner key. */
  countersignature?: Uint8Array;
  /** A fresh credential; required when the revision creates the address. */
  token?: string;
}

export interface OwnerSetupResult {
  ok: true;
  /** False when the payload was already the committed head: a safe retry. */
  applied: boolean;
  domain: string;
  username: string;
  revision: number;
  digest: string;
  state: "active" | "revoked";
  lightningAddress: string;
  lnurl: string;
  rails: { requested: string[]; effective: { id: string; available: boolean; reason?: string }[] };
}

export interface OwnerSetupRevision {
  revision: number;
  digest: string;
  previousDigest: string | null;
  intent: "enroll" | "update" | "rotate" | "revoke";
  /** base64url, exactly the bytes the owner signed. */
  payload: string;
  signature: string;
  countersignature: string | null;
  /** The x-only key the signature verifies under: the owner before this revision. */
  signerPublicKey: string;
  ownerPublicKey: string;
  acceptedAt: number;
}

export interface FetchedOwnerSetup extends OwnerSetupRevision {
  domain: string;
  username: string;
  state: "active" | "revoked";
  suspended: boolean;
  suspensionReason: string | null;
  deployment: string;
  tenant: string;
}

export function submitOwnerSetup(baseUrl: string, submission: OwnerSetupSubmission, fetchImpl: FetchImpl): Promise<OwnerSetupResult> {
  return apiFetch<OwnerSetupResult>(`${baseUrl}/lnurl/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      payload: base64urlnopad.encode(submission.payload),
      signature: base64urlnopad.encode(submission.signature),
      ...(submission.countersignature ? { countersignature: base64urlnopad.encode(submission.countersignature) } : {}),
      ...(submission.token !== undefined ? { token: submission.token } : {}),
    }),
  }, fetchImpl);
}

export function fetchOwnerSetup(baseUrl: string, domain: string, username: string, fetchImpl: FetchImpl): Promise<FetchedOwnerSetup> {
  const query = new URLSearchParams({ domain, username });
  return apiFetch<FetchedOwnerSetup>(`${baseUrl}/lnurl/setup?${query}`, undefined, fetchImpl);
}

export function fetchOwnerSetupHistory(
  baseUrl: string, domain: string, username: string, opts: { limit?: number } | undefined, fetchImpl: FetchImpl,
): Promise<{ domain: string; username: string; revisions: OwnerSetupRevision[] }> {
  const query = new URLSearchParams({ domain, username, ...(opts?.limit !== undefined ? { limit: String(opts.limit) } : {}) });
  return apiFetch(`${baseUrl}/lnurl/setup/history?${query}`, undefined, fetchImpl);
}
