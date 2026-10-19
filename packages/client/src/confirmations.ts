import { createLnurlClient, type LnurlClient } from "./index.js";
import { verifyStatusIsFor } from "./payer.js";
import type { VerifyExpectation, VerifyStatus } from "./types.js";

export interface ReceiverConfirmation {
  /** Defaults to verifyUrl; distinct sends can share a verify endpoint. */
  key?: string;
  verifyUrl: string;
  verifyBatch?: string;
  expect?: VerifyExpectation;
  onSettled: (status: VerifyStatus) => void;
  onError: (err: Error) => void;
  /** Original send time in milliseconds, so resuming preserves its deadline. */
  startedAt?: number;
  timeoutMs?: number;
}

export interface PendingConfirmations {
  add(confirmation: ReceiverConfirmation): void;
  forget(): void;
}

interface Entry extends ReceiverConfirmation {
  deadline: number;
  soloPolling?: AbortController;
}

const POLL_MS = 2_000;
const BATCH_TIMEOUT_MS = 10_000;
export const CONFIRMATION_TIMEOUT_MS = 180_000;

export function createPendingConfirmations(
  client: Pick<LnurlClient, "pollVerify" | "batchVerify"> = createLnurlClient(),
): PendingConfirmations {
  const entries = new Set<Entry>();
  const batches = new Set<AbortController>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;
  let generation = 0;

  function maybeStop(): void {
    if (timer && entries.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  function finish(entry: Entry, notify: () => void): void {
    if (!entries.delete(entry)) return;
    entry.soloPolling?.abort();
    maybeStop();
    try { notify(); } catch { /* A consumer callback must not stop other confirmations. */ }
  }

  const fail = (entry: Entry, err: Error): void => finish(entry, () => entry.onError(err));
  const expire = (entry: Entry): boolean => {
    if (Date.now() < entry.deadline) return false;
    fail(entry, new Error("receiver did not confirm settlement in time"));
    return true;
  };
  function settle(entry: Entry, status: VerifyStatus): void {
    if (expire(entry)) return;
    if (entry.expect && !verifyStatusIsFor(status, entry.expect)) {
      fail(entry, new Error("verify answered about a different payment"));
    } else if (status.settled) {
      finish(entry, () => entry.onSettled(status));
    }
  }

  async function tick(current: number): Promise<void> {
    const now = Date.now();
    for (const entry of [...entries]) expire(entry);

    const groups = new Map<string, Entry[]>();
    for (const entry of entries) {
      if (entry.soloPolling) continue;
      if (entry.verifyBatch === undefined) {
        entry.soloPolling = new AbortController();
        void Promise.resolve().then(() => client.pollVerify(entry.verifyUrl, {
          intervalMs: POLL_MS,
          timeoutMs: entry.deadline - now,
          signal: entry.soloPolling!.signal,
          ...(entry.expect ? { expect: entry.expect } : {}),
        })).then((status) => settle(entry, status)).catch((err: unknown) =>
          fail(entry, err instanceof Error ? err : new Error(String(err))));
      } else {
        const group = groups.get(entry.verifyBatch) ?? [];
        group.push(entry);
        groups.set(entry.verifyBatch, group);
      }
    }

    for (const [endpoint, group] of groups) {
      if (current !== generation) return;
      const active = group.filter((entry) => entries.has(entry) && !expire(entry));
      if (!active.length) continue;
      const abort = new AbortController();
      batches.add(abort);
      const cancelled = new Promise<never>((_, reject) => {
        abort.signal.addEventListener("abort", () => reject(new Error("batch verify aborted")), { once: true });
      });
      const cutoff = setTimeout(() => abort.abort(), Math.max(0,
        Math.min(BATCH_TIMEOUT_MS, ...active.map((entry) => entry.deadline - Date.now()))));
      try {
        // The race also bounds injected transports that ignore AbortSignal.
        const body = await Promise.race([
          client.batchVerify(endpoint, [...new Set(active.map((entry) => entry.verifyUrl))], { signal: abort.signal }),
          cancelled,
        ]);
        for (const entry of active) {
          const answer = body.results[entry.verifyUrl];
          if (!answer || answer.kind !== "verify") {
            fail(entry, new Error(answer?.reason ?? "no answer for this verify URL"));
          } else {
            settle(entry, answer.status);
          }
        }
      } catch {
        // Transport errors retry next tick; the original deadline still applies.
      } finally {
        clearTimeout(cutoff);
        batches.delete(abort);
      }
    }
  }

  function ensure(): void {
    if (timer) return;
    timer = setInterval(() => {
      if (ticking) return;
      const current = generation;
      ticking = true;
      void tick(current).finally(() => {
        if (current === generation) ticking = false;
      });
    }, POLL_MS);
  }

  return {
    add(confirmation) {
      if ([...entries].some((entry) => (entry.key ?? entry.verifyUrl) === (confirmation.key ?? confirmation.verifyUrl))) return;
      entries.add({
        ...confirmation,
        deadline: (confirmation.startedAt ?? Date.now()) + (confirmation.timeoutMs ?? CONFIRMATION_TIMEOUT_MS),
      });
      ensure();
    },
    forget() {
      const forgotten = [...entries];
      entries.clear();
      generation++;
      ticking = false;
      maybeStop();
      for (const entry of forgotten) entry.soloPolling?.abort();
      for (const abort of batches) abort.abort();
      batches.clear();
    },
  };
}
