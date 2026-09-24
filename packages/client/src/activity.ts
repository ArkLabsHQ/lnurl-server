import type { ActivityResolver, ArkTransaction } from "@arkade-os/sdk";
import type { StoredPayment } from "./sync.js";

/** Namespaced so it cannot clobber the SDK's own resolvers. */
export const LNURL_RESOLVER_ID = "lnurl:payments";
export const SENT_RESOLVER_ID = "lnurl:sends";

export const LNURL_GROUP_PREFIX = "lnurl:";
export const SENT_GROUP_PREFIX = "sent:";

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
  /** Set once the receiver's LUD-21 verify answers, where a rail hands one out. */
  receiverConfirmed?: boolean;
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
export function sentActivityResolver(sends: () => SentPayment[]): ActivityResolver {
  let byTxid = new Map<string, SentPayment>();
  return {
    id: SENT_RESOLVER_ID,
    prepare: async () => {
      byTxid = new Map(sends().filter((s) => s.txid).map((s) => [s.txid, s]));
    },
    resolve: (tx: ArkTransaction) => {
      const sent = byTxid.get(tx.key.arkTxid);
      if (!sent) return undefined;
      return [{
        groupId: `${SENT_GROUP_PREFIX}${sent.txid}`,
        // The counterparty, not the rail: that is the question a sent row answers.
        label: `→ ${sent.target}`,
        kind: "lnurl-send",
        metadata: {
          target: sent.target,
          rail: sent.railId,
          delivered: `${sent.amountSat} sats`,
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
 *  never holds. */
export function lnurlActivityResolver(payments: () => StoredPayment[]): ActivityResolver {
  let byTxid = new Map<string, StoredPayment>();
  return {
    id: LNURL_RESOLVER_ID,
    prepare: async () => {
      byTxid = new Map(
        payments()
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
        kind: "lnurl",
        metadata: {
          rail: railOf(payment),
          lightningAddress: payment.lightningAddress,
          identifier: payment.identifier,
          verified: payment.settled,
        },
      }];
    },
  };
}
