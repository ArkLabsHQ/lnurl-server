import { chainName, normalizeTokenQuote, type InvoiceResult, type TokenOption, type TokenQuote } from "@arkade-os/lnurl-client";

export const tokenLabel = (token: TokenOption): string =>
  [token.provider, `${token.unit.code} on ${chainName(token.asset.chainId)}`].filter(Boolean).join(" · ");

export function tokenDeposit(option: TokenOption, result: InvoiceResult): TokenQuote {
  if (result.kind !== "destination") throw new Error("The callback returned no token deposit");
  if (result.paymentDestinationTag) throw new Error("This deposit needs a memo; this QR cannot carry it");
  return normalizeTokenQuote(option, result);
}
