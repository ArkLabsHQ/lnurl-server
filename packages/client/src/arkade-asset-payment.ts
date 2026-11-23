import { LnurlError } from "./errors.js";
import { lnurlFetch, type FetchImpl } from "./http.js";
import type { PayRequest } from "./types.js";

const ASSET_ID = /^[0-9a-f]{68}$/;
const MAX_AMOUNT = 18446744073709551615n;
export const ARKADE_ASSET_OPTION_PREFIX = "arkade-asset:";

export function isArkadeAssetId(value: unknown): value is string {
  return typeof value === "string" && value.length === 68 && ASSET_ID.test(value);
}

export function isArkadeAssetAmount(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= MAX_AMOUNT;
}

export interface ArkadeAssetOption {
  id: string;
  assetId: string;
  caip19Id: string;
  network: string;
  assetCallback: string;
  /** Whether the callback can issue a unique destination and receipt. */
  verifiable: boolean;
}

export interface RequestArkadeAssetPaymentOptions {
  assetId: string;
  /** A positive uint64 in the asset's smallest denomination. */
  amount: bigint | string;
  receipt?: boolean;
  signal?: AbortSignal;
}

export interface ArkadeAssetPayment {
  paymentOption: string;
  paymentDestination: string;
  assetId: string;
  /** Amount in atomic units. */
  assetAmount: string;
  network: string;
  verify?: string;
  /** Unix seconds. Present on a receipt request. */
  expiresAt?: number;
}

function sameOriginUrl(value: unknown, source: string): string | undefined {
  if (typeof value !== "string" || /\s/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol === "https:" || url.protocol === "http:") && url.origin === new URL(source).origin &&
        !url.username && !url.password && !url.hash) return url.href;
  } catch {
    return undefined;
  }
  return undefined;
}

/** Lists the enabled native Arkade assets with unambiguous payment instructions. */
export function arkadeAssetOptions(payRequest: Pick<PayRequest, "paymentOptions" | "source">): ArkadeAssetOption[] {
  if (!Array.isArray(payRequest.paymentOptions)) return [];
  const options: ArkadeAssetOption[] = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const option of payRequest.paymentOptions) {
    if (!option || option.type !== "arkade-asset" || !isArkadeAssetId(option.assetId) ||
        option.id !== `${ARKADE_ASSET_OPTION_PREFIX}${option.assetId}`) continue;
    if (seen.has(option.id)) duplicates.add(option.id);
    seen.add(option.id);
    if (option.available === false || typeof option.caip19Id !== "string" || typeof option.verifiable !== "boolean") continue;
    const asset = /^arkade:([-_a-zA-Z0-9]{1,32})\/asset:([0-9a-f]{68})$/.exec(option.caip19Id);
    const assetCallback = sameOriginUrl(option.assetCallback, payRequest.source.url);
    if (!asset || asset[0] !== option.caip19Id || asset[2] !== option.assetId || !assetCallback) continue;
    options.push({ id: option.id, assetId: option.assetId, caip19Id: option.caip19Id, network: asset[1]!, assetCallback, verifiable: option.verifiable });
  }
  return options.filter((option) => !duplicates.has(option.id));
}

/** Asks for exact payment instructions. The payer wallet checks the destination against its Arkade Service before sending. */
export async function requestArkadeAssetPayment(
  payRequest: PayRequest,
  opts: RequestArkadeAssetPaymentOptions,
  fetchImpl: FetchImpl,
): Promise<ArkadeAssetPayment> {
  const option = arkadeAssetOptions(payRequest).find((candidate) => candidate.assetId === opts.assetId);
  if (!option) throw new LnurlError("This payRequest does not offer the requested Arkade asset");
  const assetAmount = typeof opts.amount === "bigint" ? opts.amount.toString() : opts.amount;
  if (!isArkadeAssetAmount(assetAmount)) throw new LnurlError("Asset amount must be a positive uint64 in atomic units");
  if (opts.receipt && !option.verifiable) throw new LnurlError("This payRequest does not issue receipts for the requested Arkade asset");

  const body = await lnurlFetch<Record<string, unknown>>(option.assetCallback, {
    method: "POST",
    headers: { "content-type": "application/json" },
    redirect: "error",
    signal: opts.signal,
    body: JSON.stringify({ assetId: option.assetId, amount: assetAmount, ...(opts.receipt ? { receipt: true } : {}) }),
  }, fetchImpl);
  if (body?.status !== "OK" || body.paymentOption !== option.id || body.assetId !== option.assetId ||
      body.assetAmount !== assetAmount || body.network !== option.network ||
      typeof body.paymentDestination !== "string" || !body.paymentDestination || /\s/.test(body.paymentDestination)) {
    throw new LnurlError("The callback did not return the requested Arkade asset payment");
  }
  const payment: ArkadeAssetPayment = {
    paymentOption: option.id, paymentDestination: body.paymentDestination, assetId: option.assetId, assetAmount, network: option.network,
  };
  if (opts.receipt) {
    const verify = sameOriginUrl(body.verify, option.assetCallback);
    const expiresAt = body.expiresAt;
    if (!verify || typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() / 1000) {
      throw new LnurlError("The callback did not return a valid Arkade asset receipt");
    }
    return { ...payment, verify, expiresAt };
  }
  if (body.verify !== undefined || body.expiresAt !== undefined) {
    throw new LnurlError("The callback returned receipt terms for a direct Arkade asset payment");
  }
  return payment;
}
