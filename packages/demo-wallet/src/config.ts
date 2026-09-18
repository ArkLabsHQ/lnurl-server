/** Mutinynet endpoints. The LNURL domain is also the token's audience, so it
 *  must match the host that serves the address, not the API base. */
export const DEFAULT_LNURL_BASE = "https://lnurl.mutinynet.arkade.sh";
export const DEFAULT_LNURL_DOMAIN = "lnurl.mutinynet.arkade.sh";
export const DEFAULT_ARK_SERVER = "https://mutinynet.arkade.sh";
export const NETWORK = "mutinynet" as const;
/** Decides the identity's BIP44 coin type. The Arkade Service refuses a wallet
 *  whose derivation disagrees with its own network, so this is not cosmetic:
 *  mainnet derivation (coin type 0) against mutinynet fails wallet creation
 *  outright. Deliberately absent from the overrides below — see
 *  `arkServerWarning`. */
export const IS_MAINNET = false;
export const EXPLORER = "https://explorer.mutinynet.arkade.sh";

export const MNEMONIC_KEY = "arkade-demo-wallet.mnemonic";
export const USERNAME_KEY = "arkade-demo-wallet.username";
export const ENDPOINTS_KEY = "arkade-demo-wallet.endpoints";

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface EndpointOverrides {
  lnurlBase?: string;
  arkServer?: string;
}

export const DEFAULT_ENDPOINTS: Required<EndpointOverrides> = {
  lnurlBase: DEFAULT_LNURL_BASE,
  arkServer: DEFAULT_ARK_SERVER,
};

const ENDPOINT_FIELDS = ["lnurlBase", "arkServer"] as const;

function memoryStore(): KeyValueStore {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
    removeItem: (key) => { entries.delete(key); },
  };
}

/** localStorage is absent under Node — the Playwright specs import this file —
 *  and throws where a browser blocks storage; either way the defaults must load
 *  rather than take the bundle down at import. */
export function browserStore(): KeyValueStore {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.getItem(ENDPOINTS_KEY);
      return localStorage;
    }
  } catch { /* storage blocked */ }
  return memoryStore();
}

export type EndpointCheck = { ok: true; value: string } | { ok: false; error: string };

export function normalizeEndpoint(raw: string): EndpointCheck {
  const value = raw.trim().replace(/\/+$/, "");
  if (!value) return { ok: false, error: "Enter a URL." };
  let url: URL;
  try { url = new URL(value); } catch { return { ok: false, error: `Not a URL: ${value}` }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "Use an http:// or https:// URL." };
  }
  return { ok: true, value };
}

const NON_MAINNET = /mutinynet|signet|testnet|regtest|localhost|\.local$/i;
const PRIVATE_HOST = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/;

/** Flags an Arkade Service that may sit on another network. Best effort — a
 *  private regtest host carries no marker at all — so it warns and never
 *  blocks. What it must never do is flip `IS_MAINNET` to match: following the
 *  URL would hand the same phrase a different key, a different address, and no
 *  way back to whatever the old one holds. */
export function arkServerWarning(url: string): string | null {
  let host: string;
  try { host = new URL(url).hostname; } catch { return null; }
  if (NON_MAINNET.test(host) || PRIVATE_HOST.test(host) || !host.includes(".")) return null;
  return `${host} carries no signet marker. This wallet always derives signet keys (BIP44 coin `
    + `type 1) and an Arkade Service on another network refuses them, so the wallet will not open.`;
}

export function readOverrides(store: KeyValueStore = browserStore()): EndpointOverrides {
  let parsed: unknown;
  try { parsed = JSON.parse(store.getItem(ENDPOINTS_KEY) ?? "{}"); } catch { return {}; }
  if (typeof parsed !== "object" || parsed === null) return {};
  const overrides: EndpointOverrides = {};
  for (const field of ENDPOINT_FIELDS) {
    // Re-checked on read, not only on write: this record is hand-editable, and
    // a junk value reaches RestArkProvider as a URL.
    const raw = (parsed as Record<string, unknown>)[field];
    if (typeof raw !== "string") continue;
    const checked = normalizeEndpoint(raw);
    if (checked.ok && checked.value !== DEFAULT_ENDPOINTS[field]) overrides[field] = checked.value;
  }
  return overrides;
}

export type SaveResult =
  | { ok: true; overrides: EndpointOverrides }
  | { ok: false; field: keyof EndpointOverrides; error: string };

export function saveOverrides(next: EndpointOverrides, store: KeyValueStore = browserStore()): SaveResult {
  const overrides: EndpointOverrides = {};
  for (const field of ENDPOINT_FIELDS) {
    const raw = next[field];
    if (raw === undefined) continue;
    const checked = normalizeEndpoint(raw);
    if (!checked.ok) return { ok: false, field, error: checked.error };
    if (checked.value !== DEFAULT_ENDPOINTS[field]) overrides[field] = checked.value;
  }
  if (Object.keys(overrides).length > 0) store.setItem(ENDPOINTS_KEY, JSON.stringify(overrides));
  else store.removeItem(ENDPOINTS_KEY);
  return { ok: true, overrides };
}

export function clearOverrides(store: KeyValueStore = browserStore()): void {
  store.removeItem(ENDPOINTS_KEY);
}

export function lnurlDomainFor(base: string): string {
  try { return new URL(base).hostname; } catch { return DEFAULT_LNURL_DOMAIN; }
}

/** Read once: `lnurl.ts` builds its client at module scope, so an override
 *  lands on the next page load and not before. */
const active = readOverrides();

export const LNURL_BASE = active.lnurlBase ?? DEFAULT_LNURL_BASE;
/** Derived from the base rather than stored beside it: a domain that drifts
 *  from the host serving the address mints tokens that server rejects. */
export const LNURL_DOMAIN = active.lnurlBase ? lnurlDomainFor(active.lnurlBase) : DEFAULT_LNURL_DOMAIN;
export const ARK_SERVER = active.arkServer ?? DEFAULT_ARK_SERVER;
