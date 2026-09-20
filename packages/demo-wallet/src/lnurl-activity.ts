import type { ActivityResolver, ArkTransaction } from "@arkade-os/sdk";
import type { StoredPayment } from "@arkade-os/lnurl-client";

/** Namespaced so it cannot clobber the SDK's own resolvers. */
export const LNURL_RESOLVER_ID = "lnurl:payments";

export const LNURL_GROUP_PREFIX = "lnurl:";

export const railOf = (p: StoredPayment): string =>
  p.kind === "bolt11" ? "lightning" : p.paymentOption ?? "destination";

export function absorbedPaymentKey(activityId: string): string | undefined {
  return activityId.startsWith(LNURL_GROUP_PREFIX) ? activityId.slice(LNURL_GROUP_PREFIX.length) : undefined;
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
        label: `${railOf(payment)} · ${payment.lightningAddress}`,
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
