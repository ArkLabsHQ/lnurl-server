import { base58, createBase58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import type { PayRequest } from "./types.js";

/** A CAIP-19 asset id, split. Its CAIP-2 prefix is the chain. */
export interface TokenAsset {
  id: string;
  chainId: string;
  namespace: string;
  chainReference: string;
  assetNamespace: string;
  reference: string;
}

/** A `units[]` entry a token option is quoted in. */
export interface TokenUnit {
  code: string;
  decimals: number;
  name?: string;
}

/** A payment option for a token on a non-Bitcoin chain, as `tokenOptions` accepts one. */
export interface TokenOption {
  id: string;
  asset: TokenAsset;
  unit: TokenUnit;
  /** False only when the payRequest says the option is down right now. */
  available: boolean;
  verifiable?: boolean;
  minSendable?: number;
  maxSendable?: number;
  /** The third party the payer hands the token to, e.g. "FixedFloat". */
  provider?: string;
}

const CAIP19 = /^([-a-z0-9]{3,8}):([-_a-zA-Z0-9]{1,32})\/([-a-z0-9]{3,8}):([-.%a-zA-Z0-9]{1,128})$/;
const UNIT_CODE = /^[A-Za-z0-9]{1,16}$/;
const tronCheck = createBase58check(sha256);

const decodes = (fn: () => boolean): boolean => {
  try {
    return fn();
  } catch {
    return false;
  }
};

// One row per namespace a wallet can build a payment for, as in the BTCPay plugin's
// TokenNamespaces.cs: no row, no way to pay it.
const NAMESPACES: Record<string, { assetNamespace: string; chain: (ref: string) => boolean; address: (a: string) => boolean }> = {
  eip155: { assetNamespace: "erc20", chain: (r) => /^[1-9][0-9]{0,18}$/.test(r), address: (a) => /^0x[0-9a-fA-F]{40}$/.test(a) },
  solana: {
    assetNamespace: "token",
    chain: () => true,
    address: (a) => decodes(() => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) && base58.decode(a).length === 32),
  },
  tron: {
    assetNamespace: "trc20",
    chain: () => true,
    address: (a) => decodes(() => {
      if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) return false;
      const bytes = tronCheck.decode(a);
      return bytes.length === 21 && bytes[0] === 0x41;
    }),
  },
};

/** True when `address` is a recipient on chains of the given CAIP-2 namespace. */
export function isTokenAddress(namespace: string, address: string): boolean {
  return NAMESPACES[namespace]?.address(address) ?? false;
}

function parseAsset(id: unknown): TokenAsset | undefined {
  const match = typeof id === "string" ? CAIP19.exec(id) : null;
  if (!match) return undefined;
  const [, namespace, chainReference, assetNamespace, reference] = match as unknown as [string, string, string, string, string];
  const ns = NAMESPACES[namespace];
  if (!ns || ns.assetNamespace !== assetNamespace || !ns.chain(chainReference) || !ns.address(reference)) return undefined;
  return { id: id as string, chainId: `${namespace}:${chainReference}`, namespace, chainReference, assetNamespace, reference };
}

function unitsOf(payRequest: Pick<PayRequest, "units">): Map<string, TokenUnit> {
  const out = new Map<string, TokenUnit>();
  for (const unit of payRequest.units ?? []) {
    const { code, decimals, name } = unit as { code?: unknown; decimals?: unknown; name?: unknown };
    if (typeof code !== "string" || !UNIT_CODE.test(code) || !Number.isInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 36) continue;
    const key = code.toUpperCase();
    if (out.has(key)) continue;
    out.set(key, { code: key, decimals: decimals as number, ...(typeof name === "string" && name.length > 0 && name.length <= 64 ? { name } : {}) });
  }
  return out;
}

const msat = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/**
 * The payRequest's token options, parsed exactly as the BTCPay LNURLVerify plugin parses
 * them (TokenOption.cs), so a wallet and a checkout agree on what is on offer.
 *
 * An option is dropped when its `asset` is not a CAIP-19 id of a namespace a payment can
 * be built for, when its `type` is not that namespace, when its `unit` names no `units[]`
 * entry, and, with every option sharing it, when its `id` is not unique.
 */
export function tokenOptions(payRequest: Pick<PayRequest, "paymentOptions" | "units">): TokenOption[] {
  const units = unitsOf(payRequest);
  const offered = (payRequest.paymentOptions ?? []).filter((o) => typeof o?.id === "string" && o.id && typeof o.type === "string" && o.type);
  const uses = new Map<string, number>();
  for (const o of offered) uses.set(o.id, (uses.get(o.id) ?? 0) + 1);
  return offered.flatMap((o): TokenOption[] => {
    const asset = parseAsset(o.asset);
    const unit = typeof o.unit === "string" ? units.get(o.unit.toUpperCase()) : undefined;
    if (uses.get(o.id)! > 1 || !asset || asset.namespace !== o.type || !unit) return [];
    const min = msat(o.minSendable);
    const max = msat(o.maxSendable);
    return [{
      id: o.id,
      asset,
      unit,
      available: o.available !== false,
      ...(typeof o.verifiable === "boolean" ? { verifiable: o.verifiable } : {}),
      ...(min !== undefined ? { minSendable: min } : {}),
      ...(max !== undefined ? { maxSendable: max } : {}),
      ...(typeof o.provider === "string" && o.provider ? { provider: o.provider } : {}),
    }];
  });
}
