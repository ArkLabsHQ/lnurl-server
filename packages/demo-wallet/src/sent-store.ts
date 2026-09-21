const SENT_KEY = "arkade-demo-wallet.sent";

/** What this wallet knows about a payment it made. Nothing else does: the server
 *  that recorded a send was the recipient's, so its record is theirs, not ours. */
export interface SentPayment {
  /** Arkade txid — the join key to the wallet's own activity row. */
  txid: string;
  /** What the user typed: a Lightning address, an LNURL, or a bare address. */
  target: string;
  railId: string;
  amountSat: number;
  feeSat: number;
  createdAt: number;
  swapId?: string;
  preimage?: string;
  /** Set once the receiver's LUD-21 verify answers, where a rail hands one out. */
  receiverConfirmed?: boolean;
}

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
  const byTxid = new Map(read().map((s) => [s.txid, s]));
  byTxid.set(sent.txid, { ...byTxid.get(sent.txid), ...sent });
  localStorage.setItem(SENT_KEY, JSON.stringify([...byTxid.values()]));
}

export function sentPayments(): SentPayment[] {
  return read().sort((a, b) => b.createdAt - a.createdAt);
}

export function forgetSent(): void {
  localStorage.removeItem(SENT_KEY);
}
