import { mergeSentPayment, type SentPayment } from "@arkade-os/lnurl-client/arkade";

const SENT_KEY = "arkade-demo-wallet.sent";

const read = (): SentPayment[] => {
  try {
    const raw = localStorage.getItem(SENT_KEY);
    return raw ? (JSON.parse(raw) as SentPayment[]) : [];
  } catch {
    return [];
  }
};

/** Replace by txid, so a later verify result updates the row it belongs to. */
export function recordSent(sent: SentPayment): void {
  localStorage.setItem(SENT_KEY, JSON.stringify(mergeSentPayment(read(), sent)));
}

export function sentPayments(): SentPayment[] {
  return read().sort((a, b) => b.createdAt - a.createdAt);
}

export function forgetSent(): void {
  localStorage.removeItem(SENT_KEY);
}
