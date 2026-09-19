import type { Activity, Wallet } from "@arkade-os/sdk";
import type { StoredPayment } from "@arkade-os/lnurl-client";

/**
 * `untracked` is not a softer `pending`. A rail whose settlement nothing
 * observes — the onchain option pays a Bitcoin address and this service watches
 * the Arkade indexer, not Bitcoin — can never leave `settled: false`, so
 * rendering it as pending promises an update that is never coming.
 */
export type FeedStatus = "settled" | "pending" | "untracked";

export interface FeedRow {
  key: string;
  /** `wallet` is the SDK's own history; `lnurl` is what the server recorded. */
  source: "wallet" | "lnurl";
  label: string;
  /** Signed on wallet rows (negative when sent); always positive on lnurl rows. */
  amountSat: number | null;
  status: FeedStatus;
  createdAt: number;
}

/** A destination record on a rail nothing watches stays false forever. */
const lnurlStatus = (p: StoredPayment): FeedStatus =>
  p.settled ? "settled" : p.paymentOption === "onchain" ? "untracked" : "pending";

const walletLabel = (a: Activity): string =>
  a.intent?.label ?? (a.amount >= 0 ? "received" : "sent");

export function walletRows(activities: Activity[]): FeedRow[] {
  return activities.map((a) => ({
    key: `wallet|${a.id}`,
    source: "wallet",
    label: walletLabel(a),
    amountSat: a.amount,
    status: a.settled ? "settled" : "pending",
    createdAt: a.createdAt,
  }));
}

export function lnurlRows(payments: StoredPayment[]): FeedRow[] {
  return payments.map((p) => ({
    key: `lnurl|${p.key}`,
    source: "lnurl",
    label: p.kind === "bolt11" ? "lightning" : p.paymentOption ?? "destination",
    amountSat: p.amountMsat === null ? null : p.amountMsat / 1000,
    status: lnurlStatus(p),
    createdAt: p.createdAt,
  }));
}

/**
 * The two halves answer different questions and neither subsumes the other: the
 * wallet knows what its keys moved, the server knows what was quoted against
 * this address — including payments that never arrived, which have no
 * transaction to appear as. They are shown side by side rather than reconciled,
 * because a settled receive legitimately exists in both.
 */
export function mergeFeed(activities: Activity[], payments: StoredPayment[]): FeedRow[] {
  return [...walletRows(activities), ...lnurlRows(payments)].sort((a, b) => b.createdAt - a.createdAt);
}

export async function readWalletActivity(wallet: Wallet): Promise<Activity[]> {
  try {
    return await wallet.getActivityHistory();
  } catch {
    // A wallet too old to group activities must not blank the LNURL half.
    return [];
  }
}
