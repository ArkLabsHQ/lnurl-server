import { LnurlError, LnurlTransportError } from "./errors.js";

export type FetchImpl = typeof globalThis.fetch;

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

/** LUD-06 surface: HTTP 200 carrying {status:"ERROR", reason} is still an error. */
export function lnurlFetch<T>(url: string, init: RequestInit | undefined, fetchImpl: FetchImpl): Promise<T> {
  return fetchJson<T>(url, init, fetchImpl);
}

/** Management surface: non-2xx carrying {error, code?}. */
export function apiFetch<T>(url: string, init: RequestInit | undefined, fetchImpl: FetchImpl): Promise<T> {
  return fetchJson<T>(url, init, fetchImpl);
}
