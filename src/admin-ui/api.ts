export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly details?: string[]) {
    super(message);
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/admin/api${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Can't reach the admin API. Check that the server is running.", 0);
  }
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string; code?: string; details?: unknown };
    throw new ApiError(b.error ?? `${res.status} ${res.statusText}`, res.status, b.code, Array.isArray(b.details) ? b.details.map(String) : undefined);
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(p: string) => req<T>("GET", p),
  post: <T>(p: string, b: unknown) => req<T>("POST", p, b),
  patch: <T>(p: string, b: unknown) => req<T>("PATCH", p, b),
  put: <T>(p: string, b: unknown) => req<T>("PUT", p, b),
  del: <T>(p: string) => req<T>("DELETE", p),
};

/** `?a=1&b=2` from the non-empty entries, or "" when none are left. */
export function query(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]);
  return entries.length ? `?${new URLSearchParams(entries).toString()}` : "";
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Answered when the server was started without the feature behind the route. */
export const notConfigured = (e: unknown): boolean => e instanceof ApiError && (e.status === 503 || e.status === 501);

export type AllocationMode = "self" | "random" | "admin" | "session";

export interface Domain {
  id: number;
  domain: string;
  allocationModes: AllocationMode[];
  requireApiKey: boolean;
  enabled: boolean;
  maxPerSession: number | null;
  usernameMinLen: number;
  usernameMaxLen: number;
  usernamePattern: string;
  minSendable: number | null;
  maxSendable: number | null;
}

export interface AddressRail { id: string; label: string; enabled: boolean; available: boolean; reason?: string }
export interface Address {
  id: number;
  username: string;
  domain: string | null;
  status: "reserved" | "active" | "revoked";
  sessionId: string | null;
  online: boolean;
  createdAt: number;
  disabledRails: string[];
  rails: AddressRail[];
}
export interface AddressPage { addresses: Address[]; nextCursor?: string }

export interface ClaimCode { id: number; domain: string | null; createdAt: number; redeemedAt: number | null; username: string | null }
export interface ServerRail { id: string; label: string; description: string; configured: boolean; ready: boolean; reason?: string }
export interface ApiKey { id: number; label: string | null; status: "active" | "revoked"; domainId: number | null; createdAt: number; lastUsedAt: number | null }
export interface BlacklistEntry { id: number; username: string; domainId: number | null; reason: string | null; createdAt: number }

export interface SessionRow {
  sessionId: string;
  connectedAt: number;
  ip: string | null;
  reusable: boolean;
  invoicesIssued: number;
  lastInvoiceAt: number | null;
  pending: { amountMsat: number; comment?: string; since: number } | null;
  addresses: Array<{ username: string; domain: string | null; status: string }>;
}

export interface Quote { amount: string; unit: string; decimals: number }
export interface SettlementRow {
  paymentHash: string;
  sessionId: string;
  settled: boolean;
  swapId: string | null;
  paymentOption: string;
  paymentDestination: string | null;
  paymentReference: string | null;
  address: { id: number; lightningAddress: string } | null;
  amountMsat: number | null;
  quote: Quote | null;
  hasPreimage: boolean;
  createdAt: number;
  settledAt: number | null;
  ffOrder?: { id: string; status: string; ffCode: string; emergency: string[] | null };
}

export interface Arrival { txid: string; vout: number; value: number; createdAt: string; attributed: boolean; paymentHash?: string }
export interface ReconcileRow { addressId: number; arkadeAddress?: string; arrivals?: Arrival[]; unattributed?: number; error?: string }
export interface ReconcileSweep { addresses: ReconcileRow[]; unattributed: number }

export interface DiscoveryView {
  network: string;
  ready: boolean;
  candidateCount: number;
  refreshedAt: number | null;
  sources: Array<{ source: string; ok: boolean; marketCount: number; error?: string; cache?: string }>;
  warnings: string[];
  reason?: string;
}
export interface SolverCardRow {
  id: number;
  label: string;
  network: string;
  enabled: boolean;
  updatedAt: number;
  card: { name?: string; discovery_pubkey?: string };
}
export interface SavedCard { persisted: boolean; active: boolean }

export interface QuoteUnitRow {
  code: string;
  decimals: number;
  feedUrl: string;
  pricePath: string;
  source: "env" | "admin";
  overridesEnv: boolean;
  price?: string;
  updatedAt?: number;
  fresh: boolean;
  error?: string;
}

export type SettingKey = "minSendable" | "maxSendable" | "invoiceTimeoutMs" | "baseUrl" | "registrationRateLimitPerMin";
export interface SettingView { value: number | string; default: number | string; overridden: boolean }
export interface SettingsResponse { editable: Partial<Record<SettingKey, SettingView>>; readOnly: Record<string, unknown> }
