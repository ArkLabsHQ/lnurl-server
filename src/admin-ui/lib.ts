import type { Domain, Quote } from "./api.js";

const nf = new Intl.NumberFormat();
export const num = (n: number): string => nf.format(n);
export const plural = (n: number, one: string, many = `${one}s`): string => `${num(n)} ${n === 1 ? one : many}`;
export const when = (ts: number): string => new Date(ts).toLocaleString();

/** Compact "12s ago" / "3m ago" / "5h ago" / "2d ago". */
export function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export const sats = (msat: number): string => `${num(msat / 1000)} ${msat === 1000 ? "sat" : "sats"}`;

export function duration(ms: number): string {
  if (ms < 1000) return `${num(ms)} ms`;
  if (ms < 60_000) return `${num(ms / 1000)} s`;
  if (ms < 3_600_000) return `${num(Math.round(ms / 6000) / 10)} min`;
  return `${num(Math.round(ms / 360_000) / 10)} h`;
}

/** "500" in a 2-decimal unit reads "5.00 USD". */
export function unitAmount(q: Quote): string {
  const digits = q.amount.padStart(q.decimals + 1, "0");
  return `${q.decimals ? `${digits.slice(0, -q.decimals)}.${digits.slice(-q.decimals)}` : digits} ${q.unit}`;
}

/** Groups the whole part of a decimal string without a float round trip, which would print binary noise. */
export function decimal(value: string): string {
  const [whole = "", fraction] = value.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** Server reasons arrive lower-case, written to follow a colon. */
export const sentence = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export const listText = (items: string[], max = 3): string =>
  items.length <= max ? items.join(", ") : `${items.slice(0, max).join(", ")} and ${items.length - max} more`;

// The wallet's explorers (its src/lib/explorers.ts): the Arkade explorer for ark addresses, mempool for on-chain ones.
const EXPLORERS: Record<string, { arkade: string; onchain: string }> = {
  bitcoin: { arkade: "https://arkade.space", onchain: "https://mempool.space" },
  mutinynet: { arkade: "https://explorer.mutinynet.arkade.sh", onchain: "https://mutinynet.com" },
};

export function explorerLink(network: string | undefined, destination: string): string | undefined {
  const explorer = network ? EXPLORERS[network] : undefined;
  return explorer && `${/^t?ark1/i.test(destination) ? explorer.arkade : explorer.onchain}/address/${destination}`;
}

/** A whole number at or above `min`, or blank when `optional`. Returns what is wrong, if anything. */
export function intProblem(raw: string, { min = 1, max, optional = false }: { min?: number; max?: number; optional?: boolean } = {}): string | undefined {
  const t = raw.trim();
  if (!t) return optional ? undefined : "Required.";
  const n = Number(t);
  if (!Number.isInteger(n) || n < min || (max !== undefined && n > max)) {
    return max === undefined ? `Enter a whole number, ${min} or more.` : `Enter a whole number from ${min} to ${max}.`;
  }
  return undefined;
}

export const intOrNull = (raw: string): number | null => (raw.trim() ? Number(raw) : null);

/** What a pasted "https://Pay.Example.com:8443/" is stored as. The port goes because requests are
 *  matched on their Host with the port stripped (src/http/origin.ts). */
export const normalizeDomain = (raw: string): string =>
  raw.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d*$/, "").replace(/\.$/, "");

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
export function domainProblem(domain: string): string | undefined {
  if (!domain) return "Enter a domain.";
  if (domain.length > 253 || !HOST.test(domain)) return "Use a host name like pay.example.com: letters, digits, dots and hyphens.";
  return undefined;
}

export function charsetProblem(charset: string): string | undefined {
  if (!charset) return "Enter the characters names may use.";
  try {
    new RegExp(`^[${charset}]+$`);
    return undefined;
  } catch {
    return "Not a valid character set. Example: a-z0-9._-";
  }
}

export type NameRules = Pick<Domain, "usernameMinLen" | "usernameMaxLen" | "usernamePattern">;

/** The server's own username check (src/usernames.ts and AddressService.assertUsername), run before asking it. */
export function usernameProblem(name: string, rules: NameRules): string | undefined {
  if (!name) return "Enter a username.";
  let charset: RegExp;
  try {
    charset = new RegExp(`^[${rules.usernamePattern}]*$`);
  } catch {
    return "This domain's allowed characters aren't a valid set. Fix them in Domains.";
  }
  if (!charset.test(name)) return `Only these characters: ${rules.usernamePattern}`;
  if (name.length < rules.usernameMinLen || name.length > rules.usernameMaxLen) {
    return `Use ${rules.usernameMinLen} to ${rules.usernameMaxLen} characters.`;
  }
  if (/^[0-9a-f]{32}$/.test(name)) return "32 hex characters read as a session handle. Pick another name.";
  return undefined;
}

