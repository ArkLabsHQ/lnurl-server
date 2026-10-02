import { BIP21 } from "@arkade-os/sdk";

/** The send amount once `raw` is entered. The router sends an explicit amount over a
 *  request's own `amount=`, so a field left at its old value would underpay the request. */
export const sendAmountFor = (raw: string, current: number): number => BIP21.amountSats(raw.trim()) ?? current;
