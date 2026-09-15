import { LnurlError, LnurlTransportError } from "./errors.js";

/**
 * The `fetch` implementation this client calls.
 *
 * Deliberately structural rather than `typeof globalThis.fetch`: an
 * implementation whose signature differs slightly — notably `expo/fetch`,
 * which React Native needs for a readable `response.body` — is then
 * assignable without an `as unknown as` cast. Only string URLs are ever
 * passed, so any `fetch` accepting something wider satisfies this.
 */
export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

async function callFetch(url: string, init: RequestInit | undefined, fetchImpl: FetchImpl): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (err) {
    if (err instanceof LnurlError) throw err;
    throw new LnurlTransportError("Request failed", { cause: err });
  }
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (err) {
    if (!response.ok) throw new LnurlError(response.statusText, { httpStatus: response.status });
    throw new LnurlTransportError("Request failed", { cause: err });
  }
}

function throwForStatus(response: Response, body: unknown): void {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined;
  const ludReason = record?.["status"] === "ERROR" && typeof record?.["reason"] === "string" ? (record["reason"] as string) : undefined;
  const apiReason = typeof record?.["error"] === "string" ? (record["error"] as string) : undefined;
  const code = typeof record?.["code"] === "string" ? (record["code"] as string) : undefined;
  // Rate limits mix the shapes (HTTP 429 carrying {status:"ERROR"}), so both helpers check both.
  const reason = ludReason ?? apiReason;
  const httpStatus = response.ok ? undefined : response.status;
  if (reason !== undefined) throw new LnurlError(reason, { httpStatus, code });
  if (!response.ok) throw new LnurlError(apiReason ?? response.statusText, { httpStatus: response.status, code });
}

async function fetchJson<T>(url: string, init: RequestInit | undefined, fetchImpl: FetchImpl): Promise<T> {
  const response = await callFetch(url, init, fetchImpl);
  const body = await readBody(response);
  throwForStatus(response, body);
  return body as T;
}

/**
 * `fetch` wrapper for the LUD-06 payer surface (`payRequest`, callback,
 * verify): an `HTTP 200` carrying `{ status: "ERROR", reason }` is still an
 * error, so the body is inspected even on success statuses.
 *
 * @param url - The absolute URL to request.
 * @param init - Optional `fetch` init; undefined for plain GETs.
 * @param fetchImpl - The injected `fetch` implementation to call.
 * @returns The parsed JSON body, typed as `T`.
 */
export function lnurlFetch<T>(url: string, init: RequestInit | undefined, fetchImpl: FetchImpl): Promise<T> {
  return fetchJson<T>(url, init, fetchImpl);
}

/**
 * `fetch` wrapper for the management surface (session/address endpoints):
 * failures carry a real status code with `{ error, code? }`. A 429 may wear
 * either shape, so both are checked before falling back to `statusText`.
 *
 * @param url - The absolute URL to request.
 * @param init - Optional `fetch` init; undefined for plain GETs.
 * @param fetchImpl - The injected `fetch` implementation to call.
 * @returns The parsed JSON body, typed as `T`.
 */
export function apiFetch<T>(url: string, init: RequestInit | undefined, fetchImpl: FetchImpl): Promise<T> {
  return fetchJson<T>(url, init, fetchImpl);
}
