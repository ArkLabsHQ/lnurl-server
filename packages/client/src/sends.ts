import type { PaymentHandle, RouteQuote } from "@arkade-os/sdk";
import { mergeSentPayment, type SentPayment } from "./activity.js";
import { createPendingConfirmations, type PendingConfirmations } from "./confirmations.js";
import { lnurlQuoteMeta } from "./rail.js";
import type { VerifyExpectation } from "./types.js";

export interface LnurlSentPaymentStore {
  read(): SentPayment[];
  write(records: SentPayment[]): void;
}

export interface LnurlSendTrackerOptions {
  onError(error: unknown): void;
  confirmations?: PendingConfirmations;
}

/** Shared send bookkeeping over the application's synchronous persistence. */
export function createLnurlSendTracker(
  store: LnurlSentPaymentStore,
  options: LnurlSendTrackerOptions,
) {
  const confirmations = options.confirmations ?? createPendingConfirmations();
  const subscriptions = new Set<() => void>();
  let generation = 0;
  const persist = (update: (existing: SentPayment[]) => SentPayment[] | undefined): void => {
    try {
      const rows = update(store.read());
      if (rows) store.write(rows);
    } catch (error) {
      options.onError(error);
    }
  };
  const save = (sent: SentPayment): void => persist((rows) => mergeSentPayment(rows, sent));
  const mark = (txid: string, confirmed: boolean): void => persist((rows) => {
    const sent = rows.find((row) => row.txid === txid);
    return sent ? mergeSentPayment(rows, { ...sent, receiverConfirmed: confirmed }) : undefined;
  });
  const watch = (txid: string, verify: string, verifyBatch?: string, startedAt?: number, expect?: VerifyExpectation): void => {
    const current = generation;
    confirmations.add({
      key: txid, verifyUrl: verify, verifyBatch, startedAt, expect,
      onSettled: () => { if (current === generation) mark(txid, true); },
      onError: () => { if (current === generation) mark(txid, false); },
    });
  };
  return {
    all: (): SentPayment[] => store.read(),
    record(handle: PaymentHandle, quote: RouteQuote, target: string): () => void {
      const createdAt = Date.now();
      const current = generation;
      const meta = lnurlQuoteMeta(quote);
      let stopped = false;
      let unsubscribe: (() => void) | undefined;
      const stop = (): void => {
        stopped = true;
        unsubscribe?.();
        subscriptions.delete(stop);
      };
      subscriptions.add(stop);
      unsubscribe = handle.subscribe(({ status, result }) => {
        if (stopped || current !== generation) return;
        try {
          if (result?.txid) save({
            txid: result.txid, target: meta?.target ?? target, railId: quote.railId,
            amountSat: quote.amount, feeSat: quote.fee, createdAt,
            ...(result.swapId ? { swapId: result.swapId } : {}),
            ...(result.preimage ? { preimage: result.preimage } : {}),
            ...(meta?.verify ? { verify: meta.verify } : {}),
            ...(meta?.verifyBatch ? { verifyBatch: meta.verifyBatch } : {}),
            ...(meta?.expect ? { expect: meta.expect } : {}),
            ...(meta?.quote ? { quote: meta.quote } : {}),
          });
        } finally {
          if (status === "settled" || status === "failed") stop();
        }
      });
      // A handle may replay a terminal update before subscribe returns.
      if (stopped) unsubscribe();
      return stop;
    },
    watch,
    resume(): void {
      for (const sent of store.read()) {
        if (sent.verify && sent.receiverConfirmed === undefined)
          watch(sent.txid, sent.verify, sent.verifyBatch, sent.createdAt, sent.expect);
      }
    },
    mark,
    forget(): void {
      generation++;
      confirmations.forget();
      for (const stop of subscriptions) stop();
    },
  };
}
