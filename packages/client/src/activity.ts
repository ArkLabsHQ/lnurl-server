import type { ActivityResolver, ArkTransaction } from "@arkade-os/sdk";
import type { StoredPayment } from "./sync.js";
import type { QuotedAmount, VerifyExpectation } from "./types.js";
import { formatUnitAmount } from "./units.js";

/** "5.00 USD": how a quoted amount reads in an activity row. */
export const quotedLabel = (q: QuotedAmount): string => `${formatUnitAmount(q.amount, q.decimals)} ${q.unit}`;

/** Namespaced so it cannot clobber the SDK's own resolvers. */
export const LNURL_RESOLVER_ID = "lnurl:payments";
export const SENT_RESOLVER_ID = "lnurl:sends";

export const LNURL_GROUP_PREFIX = "lnurl:";
export const SENT_GROUP_PREFIX = "sent:";

export const LNURL_ACTIVITY_KIND = "lnurl";
export const SENT_ACTIVITY_KIND = "lnurl-send";

export const railOf = (p: StoredPayment): string =>
  p.kind === "bolt11" ? "lightning" : p.paymentOption ?? "destination";

export function absorbedPaymentKey(activityId: string): string | undefined {
  return activityId.startsWith(LNURL_GROUP_PREFIX) ? activityId.slice(LNURL_GROUP_PREFIX.length) : undefined;
}

/** What a wallet knows about a payment it made. Nothing else does: the server
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
  /** The LUD-21 verify URL and LUD-XX verifyBatch endpoint the quote carried, kept so a
   *  confirmation still pending when the app closes can be resumed. */
  verify?: string;
  verifyBatch?: string;
  expect?: VerifyExpectation;
  /** Set once the receiver's LUD-21 verify answers, where a rail hands one out. */
  receiverConfirmed?: boolean;
  /** What the payer asked to pay in a LUD-XX unit; absent when they paid in sats. */
  quote?: QuotedAmount;
}

/** What to keep on file after a completed send: `incoming` replaces the record
 *  sharing its txid, so a later verify result updates that row rather than
 *  duplicating it. Storage — reading the existing set, writing the result — is
 *  the caller's. */
export function mergeSentPayment(existing: SentPayment[], incoming: SentPayment): SentPayment[] {
  const byTxid = new Map(existing.map((s) => [s.txid, s]));
  byTxid.set(incoming.txid, { ...byTxid.get(incoming.txid), ...incoming });
  return [...byTxid.values()];
}

/** Labels a payment this wallet MADE, from what it recorded at send time. Joined
 *  on the rail's txid, never inferred from amount and timing as an incoming quote
 *  may be: naming a recipient the money did not go to is worse than naming none. */
export function sentActivityResolver(sends: () => SentPayment[] | Promise<SentPayment[]>): ActivityResolver {
  let byTxid = new Map<string, SentPayment>();
  return {
    id: SENT_RESOLVER_ID,
    prepare: async () => {
      byTxid = new Map((await sends()).filter((s) => s.txid).map((s) => [s.txid, s]));
    },
    resolve: (tx: ArkTransaction) => {
      const sent = byTxid.get(tx.key.arkTxid);
      if (!sent) return undefined;
      return [{
        groupId: `${SENT_GROUP_PREFIX}${sent.txid}`,
        // The counterparty, not the rail: that is the question a sent row answers.
        label: `→ ${sent.target}`,
        kind: SENT_ACTIVITY_KIND,
        metadata: {
          target: sent.target,
          rail: sent.railId,
          delivered: `${sent.amountSat} sats`,
          ...(sent.quote ? { requested: quotedLabel(sent.quote) } : {}),
          ...(sent.feeSat > 0 ? { fee: `${sent.feeSat} sats` } : {}),
          ...(sent.swapId ? { swap: sent.swapId } : {}),
          ...(sent.preimage ? { preimage: sent.preimage } : {}),
          ...(sent.receiverConfirmed === undefined
            ? {}
            : { receiver: sent.receiverConfirmed ? "confirmed settled" : "has not confirmed" }),
        },
      }];
    },
  };
}

/** Joined on `payoutReference`, never `paymentReference`: the latter is what the
 *  service observed, which on two of the three rails is an output this wallet
 *  never holds. `payments` is read on every `prepare`, so `repository.all` fits as is. */
export function lnurlActivityResolver(payments: () => StoredPayment[] | Promise<StoredPayment[]>): ActivityResolver {
  let byTxid = new Map<string, StoredPayment>();
  return {
    id: LNURL_RESOLVER_ID,
    prepare: async () => {
      byTxid = new Map(
        (await payments())
          .filter((p): p is StoredPayment & { payoutReference: string } => Boolean(p.payoutReference))
          .map((p) => [p.payoutReference, p]),
      );
    },
    resolve: (tx: ArkTransaction) => {
      const payment = byTxid.get(tx.key.arkTxid);
      if (!payment) return undefined;
      return [{
        groupId: `${LNURL_GROUP_PREFIX}${payment.key}`,
        label: `${railOf(payment)} · ${payment.lightningAddress ?? "LNURL"}`,
        kind: LNURL_ACTIVITY_KIND,
        metadata: {
          rail: railOf(payment),
          lightningAddress: payment.lightningAddress,
          identifier: payment.identifier,
          verified: payment.settled,
          ...(payment.quote ? { requested: quotedLabel(payment.quote) } : {}),
        },
      }];
    },
  };
}

/** What either resolver recorded on an activity row, typed: the counterparty for a send, our own address for a receive. */
export function lnurlActivity(activity: { id: string; intent?: { metadata?: Record<string, unknown> } }):
  { direction: "received" | "sent"; address?: string; rail?: string } | undefined {
  const sent = activity.id.startsWith(SENT_GROUP_PREFIX);
  if (!sent && !activity.id.startsWith(LNURL_GROUP_PREFIX)) return undefined;
  const meta = activity.intent?.metadata ?? {};
  const address = sent ? meta.target : meta.lightningAddress;
  return {
    direction: sent ? "sent" : "received",
    ...(typeof address === "string" ? { address } : {}),
    ...(typeof meta.rail === "string" ? { rail: meta.rail } : {}),
  };
}
