import { BIP21, invoiceTarget } from "@arkade-os/sdk";
import { invoiceFactsFromBolt11 } from "../../../src/bolt11.js";

/** The send amount once `raw` is entered. The router sends an explicit amount over a
 *  request's own `amount=`, so a field left at its old value would underpay the request.
 *  Failing that, an invoice's own amount, the only one the solver rail pays.
 *  `amount=0` asks for nothing, so it keeps the typed amount too. */
export const sendAmountFor = (raw: string, current: number): number =>
  BIP21.amountSats(raw.trim()) || invoiceSats(raw.trim()) || current;

function invoiceSats(raw: string): number {
  const invoice = invoiceTarget(raw);
  if (!invoice) return 0;
  try {
    return invoiceFactsFromBolt11(invoice).amountSats;
  } catch {
    return 0;
  }
}
