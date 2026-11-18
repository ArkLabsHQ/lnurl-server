import { payableTokenUri, tokenOptions, type InvoiceResult, type PayRequest } from "@arkade-os/lnurl-client";

export function receivePaymentValue(payRequest: PayRequest, optionId: string, result: InvoiceResult): string {
  if (optionId === "satora" || (result.kind === "destination" && result.paymentOption === "satora")) {
    throw new Error("Use the Satora payment flow to pay this request");
  }
  const token = tokenOptions(payRequest).find((option) => option.id === optionId);
  if (result.kind === "destination" && token && result.paymentDestinationTag) {
    throw new Error("This deposit needs a memo; this QR cannot carry it");
  }
  return result.kind === "destination" && token
    ? payableTokenUri(token, result)
    : (result.kind === "bolt11" ? result.pr : result.paymentDestination) ?? "";
}
