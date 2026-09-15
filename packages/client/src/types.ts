export interface PaymentOption {
  id: string;
  type: string;
  available?: boolean;
  minSendable?: number;
  maxSendable?: number;
}
export interface Unit {
  code: string;
  decimals: number;
  name?: string;
  symbol?: string;
  assetId?: string;
  minAmount?: string;
  maxAmount?: string;
}
export interface AmountObject {
  amount: string;
  unit: string;
}
export interface PaymentQuote {
  id?: string;
  expiresAt?: string;
  requested: AmountObject;
  payment: AmountObject;
  receive?: AmountObject;
  fees?: { name?: string; amount: AmountObject }[];
}
export interface PayRequest {
  tag: "payRequest";
  callback: string;
  minSendable: number;
  maxSendable: number;
  metadata: string;
  commentAllowed?: number;
  paymentOptions?: PaymentOption[];
  units?: Unit[];
  source: { url: string; surface: "address" | "session" };
}

export interface RequestInvoiceOptions {
  amountSat: number;
  comment?: string;
  /** Address surface only. Rejected on a session payRequest. */
  paymentOption?: string;
  /** Address surface only, lightning rail only. */
  unit?: string;
}
export type InvoiceResult = Bolt11Result | DestinationResult;
export interface Bolt11Result {
  kind: "bolt11";
  pr: string;
  verify?: string;
  paymentOption?: string;
  paymentQuote?: PaymentQuote;
}
export interface DestinationResult {
  kind: "destination";
  paymentOption: string;
  paymentDestination?: string;
  verify?: string;
}
export type VerifyStatus = Bolt11VerifyStatus | DestinationVerifyStatus;
export interface Bolt11VerifyStatus {
  kind: "bolt11";
  settled: boolean;
  preimage: string | null;
  pr: string;
}
export interface DestinationVerifyStatus {
  kind: "destination";
  settled: boolean;
  paymentOption: string;
  paymentDestination?: string;
  paymentReference?: string;
}
export interface PollVerifyOptions {
  intervalMs?: number;
  timeoutMs?: number;
  onUpdate?: (s: VerifyStatus) => void;
  signal?: AbortSignal;
}