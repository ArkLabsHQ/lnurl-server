/**
 * One payment rail the receiver advertised on an address payRequest, such as
 * `lightning` or `arkade`. Rails exist only on the address surface: a session
 * payRequest never carries them, which is why `requestInvoice` rejects
 * `paymentOption`/`unit` there instead of letting the server silently ignore
 * the choice.
 */
export interface PaymentOption {
  /** Rail identifier the callback expects back as `paymentOption`. */
  id: string;
  /** Rail family, e.g. `lightning` or `arkade`. */
  type: string;
  /** Whether the rail can currently be selected. */
  available?: boolean;
  /** Minimum sendable amount on this rail. */
  minSendable?: number;
  /** Maximum sendable amount on this rail. */
  maxSendable?: number;
}
/**
 * A unit the receiver prices in on the lightning rail (fiat or asset alongside
 * the native `sat`/`msat`). Quoting a non-native unit is what produces the
 * `paymentQuote` echoed on the invoice result.
 */
export interface Unit {
  /** Unit code the callback expects back as `unit`, e.g. `USD`. */
  code: string;
  /** Decimal places amounts in this unit are expressed with. */
  decimals: number;
  /** Human-readable unit name. */
  name?: string;
  /** Display symbol for the unit. */
  symbol?: string;
  /** Asset identifier backing the unit, for asset-denominated units. */
  assetId?: string;
  /** Minimum amount expressible in this unit, as a decimal string. */
  minAmount?: string;
  /** Maximum amount expressible in this unit, as a decimal string. */
  maxAmount?: string;
}
/** An amount paired with the unit it is denominated in. */
export interface AmountObject {
  /** Decimal amount string in `unit`. */
  amount: string;
  /** Unit code from `Unit.code`. */
  unit: string;
}
/**
 * The server's quote for a unit-converted payment: what was requested, what
 * the payer pays, what the receiver gets, and the fee breakdown in between.
 */
export interface PaymentQuote {
  /** Quote identifier, when the server issues one. */
  id?: string;
  /** Expiry of the quote, when the server bounds it. */
  expiresAt?: string;
  /** Amount the payer asked to deliver. */
  requested: AmountObject;
  /** Amount the payer must actually pay. */
  payment: AmountObject;
  /** Amount the receiver will get after conversion. */
  receive?: AmountObject;
  /** Named fee legs making up the difference. */
  fees?: { name?: string; amount: AmountObject }[];
}
/**
 * An LUD-06 payRequest plus the `source` it was fetched from. The source
 * records both the URL and which surface (`address` or `session`) served it,
 * because `requestInvoice` keys its rail guards off the surface: rails,
 * units and the offline path exist only on the address side.
 */
export interface PayRequest {
  /** LUD-06 tag; `resolve` rejects anything that is not a payRequest. */
  tag: "payRequest";
  /** Callback URL the invoice request is built against. */
  callback: string;
  /** Minimum sendable amount in millisats. */
  minSendable: number;
  /** Maximum sendable amount in millisats. */
  maxSendable: number;
  /** JSON-encoded LUD-06 metadata array. */
  metadata: string;
  /** Maximum comment length in characters, when the receiver accepts one. */
  commentAllowed?: number;
  /** Rails the receiver offers; address surface only. */
  paymentOptions?: PaymentOption[];
  /** Units the receiver prices in; address surface, lightning rail only. */
  units?: Unit[];
  /** Where this payRequest came from; drives the rail guards downstream. */
  source: { url: string; surface: "address" | "session" };
}

/**
 * Options for asking the callback for an invoice or payment destination.
 * `amountSat` is sats and is converted to millisats on the wire.
 */
export interface RequestInvoiceOptions {
  /** Amount to pay in sats; converted to millisats on the wire. */
  amountSat: number;
  /** Optional payer comment, sent when the payRequest allows one. */
  comment?: string;
  /** Address surface only. Rejected on a session payRequest. */
  paymentOption?: string;
  /** Address surface only, lightning rail only. */
  unit?: string;
}
/**
 * What the callback answered: either a BOLT11 invoice to pay, or a
 * destination to pay on a non-lightning rail (e.g. an Arkade address).
 */
export type InvoiceResult = Bolt11Result | DestinationResult;
/**
 * A BOLT11 invoice from the callback. `verify` is optional because the server
 * omits it when the invoice's payment hash will not decode; `pollVerify`
 * refuses a missing one instead of polling `undefined`.
 */
export interface Bolt11Result {
  /** Discriminant for the BOLT11 shape. */
  kind: "bolt11";
  /** The BOLT11 invoice to pay. */
  pr: string;
  /** Verify URL tracking settlement; absent when the server could not decode the payment hash. */
  verify?: string;
  /** Rail the invoice was issued for, echoed back when one was selected. */
  paymentOption?: string;
  /** Quote for a unit-converted payment, when one was requested. */
  paymentQuote?: PaymentQuote;
}
/**
 * A non-BOLT11 destination from the callback: pay it on the selected rail and
 * then track settlement through `verify`, exactly like the BOLT11 shape.
 */
export interface DestinationResult {
  /** Discriminant for the destination shape. */
  kind: "destination";
  /** The selected rail both sides settle on. */
  paymentOption: string;
  /** Where to pay on that rail, e.g. an Arkade address. */
  paymentDestination?: string;
  /** Verify URL tracking settlement; absent under the same conditions as the BOLT11 shape. */
  verify?: string;
}
/** The settlement state `pollVerify` resolves with, in either rail shape. */
export type VerifyStatus = Bolt11VerifyStatus | DestinationVerifyStatus;
/** Settlement state of a BOLT11 payment: `preimage` is null until settled. */
export interface Bolt11VerifyStatus {
  /** Discriminant for the BOLT11 shape. */
  kind: "bolt11";
  /** Whether the invoice has settled. */
  settled: boolean;
  /** Payment preimage once settled, null while pending. */
  preimage: string | null;
  /** The invoice this status belongs to. */
  pr: string;
}
/** Settlement state of a destination-rail payment. */
export interface DestinationVerifyStatus {
  /** Discriminant for the destination shape. */
  kind: "destination";
  /** Whether the payment has settled. */
  settled: boolean;
  /** The rail both sides settled on. */
  paymentOption: string;
  /** Where the payment landed, when the server reports it. */
  paymentDestination?: string;
  /** Server-assigned payment reference, when the server reports one. */
  paymentReference?: string;
}
/**
 * Tuning for `pollVerify`: how often to re-poll, how long to wait overall,
 * what to report per poll, and how to abort early.
 */
export interface PollVerifyOptions {
  /** Milliseconds between polls; defaults to 1000. */
  intervalMs?: number;
  /** Overall deadline in milliseconds; defaults to 120000. */
  timeoutMs?: number;
  /** Called with every polled snapshot, including unsettled ones. */
  onUpdate?: (s: VerifyStatus) => void;
  /** Abort signal for caller-driven cancellation. */
  signal?: AbortSignal;
}
