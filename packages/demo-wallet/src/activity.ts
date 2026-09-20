import type { Activity, Wallet } from "@arkade-os/sdk";
import type { StoredPayment } from "@arkade-os/lnurl-client";
import { absorbedPaymentKey } from "./lnurl-activity.js";

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

/** One row per payment. What the resolver matched is already on the wallet row,
 *  so only what has no transaction to enhance survives here — quotes nobody paid,
 *  and payments not yet credited. */
export function mergeFeed(activities: Activity[], payments: StoredPayment[]): FeedRow[] {
  const absorbed = new Set(
    activities.map((a) => absorbedPaymentKey(a.id)).filter((key): key is string => key !== undefined),
  );
  const unmatched = payments.filter((p) => !absorbed.has(p.key));
  return [...walletRows(activities), ...lnurlRows(unmatched)].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * The SDK's own history. A failure is reported rather than swallowed: an empty
 * list and a broken call render identically, so eating the error makes the feed
 * look like it never consulted the wallet at all — which is indistinguishable,
 * from the outside, from not having wired the SDK up.
 */
export async function readWalletActivity(
  wallet: Wallet,
): Promise<{ activities: Activity[]; error?: string }> {
  try {
    return { activities: await wallet.getActivityHistory() };
  } catch (err) {
    // Still returns the empty half: a wallet too old to group activities must
    // not blank the LNURL rows beside it.
    return { activities: [], error: err instanceof Error ? err.message : String(err) };
  }
}
