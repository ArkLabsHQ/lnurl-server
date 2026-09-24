import type { Activity, Wallet } from "@arkade-os/sdk";
import type { StoredPayment } from "@arkade-os/lnurl-client";
import { absorbedPaymentKey, railOf } from "@arkade-os/lnurl-client/arkade";

/**
 * `untracked` is not a softer `pending`. A rail whose settlement nothing
 * observes — the onchain option pays a Bitcoin address and this service watches
 * the Arkade indexer, not Bitcoin — can never leave `settled: false`, so
 * rendering it as pending promises an update that is never coming.
 */
export type FeedStatus = "settled" | "pending" | "untracked";

export type Detail = [label: string, value: string];

export interface FeedRow {
  key: string;
  /** A `wallet` row is money that moved; a `quote` is one the server minted that
   *  no transaction answers yet. Only a quote carries a status — a wallet row's
   *  own settled flag says nothing a holder can act on. */
  kind: "wallet" | "quote";
  label: string;
  amountSat: number | null;
  createdAt: number;
  /** Arkade txid, for an explorer link. Absent on a quote, which has no tx. */
  txid?: string;
  status?: FeedStatus;
  details: Detail[];
}

const walletLabel = (a: Activity): string =>
  a.intent?.label ?? (a.amount >= 0 ? "received" : "sent");

const quoteStatus = (p: StoredPayment): FeedStatus =>
  p.settled ? "settled" : p.paymentOption === "onchain" ? "untracked" : "pending";

const sats = (msat: number | null): string => (msat === null ? "any" : `${msat / 1000} sats`);

function paymentDetails(p: StoredPayment): Detail[] {
  const details: Detail[] = [
    ["rail", railOf(p)],
    ["paid to", p.lightningAddress ?? p.handle],
    ["quoted", sats(p.amountMsat)],
  ];
  if (p.swapId) details.push(["swap", p.swapId]);
  if (p.preimage) details.push(["preimage", p.preimage]);
  if (p.covenantScript) details.push(["covenant", p.covenantScript]);
  if (p.settledAt) details.push(["server saw it", new Date(p.settledAt).toLocaleString()]);
  return details;
}

/** A whitelist, so a resolver's machine fields never reach the UI as raw keys. */
const INTENT_LABELS: [key: string, label: string][] = [
  ["target", "paid to"],
  ["rail", "rail"],
  ["delivered", "delivered"],
  ["fee", "rail fee"],
  ["swap", "swap"],
  ["preimage", "preimage"],
  ["receiver", "receiver"],
];

/** The only source of detail for a send, which no record of ours describes. */
function intentDetails(a: Activity): Detail[] {
  const meta = a.intent?.metadata;
  if (!meta) return [];
  return INTENT_LABELS
    .filter(([key]) => meta[key] !== undefined && meta[key] !== null && meta[key] !== "")
    .map(([key, label]) => [label, String(meta[key])] as Detail);
}

/** A destination rail pays the quoted amount exactly; only a swap takes a cut.
 *  A looser bound would let any large quote swallow any small arrival. */
const MAX_SWAP_CUT = 0.1;

function covers(p: StoredPayment, receivedSat: number): boolean {
  if (p.amountMsat === null) return false;
  const quoted = p.amountMsat / 1000;
  if (receivedSat === quoted) return true;
  return p.kind === "bolt11" && receivedSat < quoted && receivedSat >= quoted * (1 - MAX_SWAP_CUT);
}

/** The fee a rail took, where both halves are known: what was quoted against the
 *  address, less what actually landed. Absent rather than zero when either is. */
function feeDetail(quotedMsat: number | null, receivedSat: number): Detail[] {
  if (quotedMsat === null || receivedSat <= 0) return [];
  const fee = quotedMsat / 1000 - receivedSat;
  return fee > 0 ? [["rail fee", `${fee} sats`]] : [];
}

/**
 * One row per thing that happened. A wallet transaction and the server record of
 * the same payment are one event; listing both showed it twice with two states.
 *
 * Matched by `payoutReference` where the server has one. Until it does, a quote a
 * wallet row already accounts for is folded in as `inferred` — an unmatched quote
 * beside its own payment reads as a double charge. Display-only: nothing here
 * decides what settles what.
 */
export function mergeFeed(activities: Activity[], payments: StoredPayment[]): FeedRow[] {
  const byKey = new Map(payments.map((p) => [p.key, p]));
  const claimed = new Set<string>();

  const rows: FeedRow[] = activities.map((a) => {
    const exact = absorbedPaymentKey(a.id);
    let payment = exact ? byKey.get(exact) : undefined;
    let inferred = false;
    if (!payment && a.amount > 0) {
      // Keyed on the absence of a payout reference, not on `settled`: a covenant
      // payment is observed at the covenant and only its later sweep records one,
      // so it is settled with nothing to join on for the whole window between.
      payment = payments.find(
        (p) => !claimed.has(p.key) && !p.payoutReference && p.createdAt <= a.createdAt && covers(p, a.amount),
      );
      inferred = payment !== undefined;
    }
    if (payment) claimed.add(payment.key);
    const txid = a.txs[0]?.key.arkTxid || undefined;
    return {
      key: `wallet|${a.id}`,
      kind: "wallet",
      label: payment ? railOf(payment) : walletLabel(a),
      amountSat: a.amount,
      createdAt: a.createdAt,
      ...(txid ? { txid } : {}),
      details: [
        ...(txid ? ([["txid", txid]] as Detail[]) : []),
        ...(payment ? paymentDetails(payment) : intentDetails(a)),
        ...(payment ? feeDetail(payment.amountMsat, a.amount) : []),
        ...(inferred ? ([["matched", "by amount and timing, pending the server's confirmation"]] as Detail[]) : []),
      ],
    };
  });

  const quotes: FeedRow[] = payments
    .filter((p) => !claimed.has(p.key))
    .map((p) => ({
      key: `quote|${p.key}`,
      kind: "quote",
      label: railOf(p),
      amountSat: p.amountMsat === null ? null : p.amountMsat / 1000,
      createdAt: p.createdAt,
      status: quoteStatus(p),
      details: paymentDetails(p),
    }));

  return [...rows, ...quotes].sort((a, b) => b.createdAt - a.createdAt);
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
    // not blank the quotes beside it.
    return { activities: [], error: err instanceof Error ? err.message : String(err) };
  }
}
