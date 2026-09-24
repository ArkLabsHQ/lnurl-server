import { batchVerify, type VerifyBatchStream, type VerifyStatus } from "@arkade-os/lnurl-client";
import { payer } from "./lnurl.js";

// Longer than a corridor swap can take (the solver's deadline is 660s), not a poll budget.
const WATCH_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 30_000;

export interface WatchHandlers { settled: () => void; gaveUp: (reason: string) => void }
export interface SettlementWatcher {
  add(verifyUrl: string, on: WatchHandlers): void;
  pending(): number;
  stop(): void;
}

/**
 * Every pending receive at one verifyBatch endpoint, on one stream: later
 * requests join it with `update`, settled ones leave it. Reopening a closed
 * stream is the client's job under LUD-XX, so a close with anything still
 * pending reconnects with backoff, each invoice until its own window lapses.
 */
export function settlementWatcher(opts: {
  verifyBatchUrl: string;
  timeoutMs?: number;
  open?: typeof payer.openVerifyBatchStream;
  onChange?: (state: { pending: number; connected: boolean }) => void;
}): SettlementWatcher {
  const open = opts.open ?? ((o, h) => payer.openVerifyBatchStream(o, h));
  const pending = new Map<string, { on: WatchHandlers; deadline: number }>();
  const unsent = new Set<string>();
  let stream: VerifyBatchStream | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let attempt = 0;
  let lastError = "";

  const changed = (): void => opts.onChange?.({ pending: pending.size, connected: stream !== undefined });
  // `update` throws until the session frame lands; the caller retries on the next frame.
  const send = (add: string[], remove: string[] = []): boolean => {
    if (!stream) return false;
    try { stream.update(add, remove); return true; } catch { return false; }
  };

  const reopen = (): void => {
    const delay = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** attempt++);
    for (const [url, entry] of pending) {
      if (Date.now() + delay < entry.deadline) continue;
      pending.delete(url);
      entry.on.gaveUp(lastError || "not settled within the watch window");
    }
    if (pending.size) retry = setTimeout(connect, delay);
  };

  function connect(): void {
    retry = undefined;
    unsent.clear();
    stream = open({ verifyBatchUrl: opts.verifyBatchUrl, verifyUrls: [...pending.keys()] }, {
      onUpdate: (url, status) => {
        attempt = 0;
        if (unsent.size && send([...unsent])) unsent.clear();
        const entry = pending.get(url);
        if (!entry || !status.settled) return;
        pending.delete(url);
        // The server closes a stream whose every URL is settled, so removing the last one would race that close.
        if (pending.size) send([], [url]);
        changed();
        entry.on.settled();
      },
      onError: (e) => { lastError = e.message; },
      onClose: () => {
        stream = undefined;
        if (stopped) return;
        if (pending.size) reopen();
        changed();
      },
    });
    changed();
  }

  return {
    add(verifyUrl, on) {
      if (stopped || pending.has(verifyUrl)) return;
      pending.set(verifyUrl, { on, deadline: Date.now() + (opts.timeoutMs ?? WATCH_MS) });
      if (stream) { if (!send([verifyUrl])) unsent.add(verifyUrl); }
      else if (!retry) connect();
      changed();
    },
    pending: () => pending.size,
    stop() {
      stopped = true;
      clearTimeout(retry);
      pending.clear();
      stream?.close();
    },
  };
}

/** What one pending send needs from its verify answer. */
export interface ReceiverConfirmation {
  /** The LUD-21 verify URL the invoice or destination quote carried. */
  verifyUrl: string;
  /** The LUD-XX verifyBatch endpoint advertised next to it, when one exists. */
  verifyBatch?: string;
  /** Fail the entry when no settled answer has arrived within this window. */
  timeoutMs?: number;
  /** Finality per invoice: the settled status or a timeout error. */
  onSettled: (status: VerifyStatus) => void;
  onError: (err: Error) => void;
}

interface Entry extends Omit<ReceiverConfirmation, "verifyUrl"> {
  verifyUrl: string;
  deadline: number;
  /** Solo entries start their own LUD-21 poll exactly once. */
  soloPolling?: boolean;
}

const POLL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * Pending receive-confirmations this wallet is still awaiting, resolved with
 * ONE batched GET per poll cycle per LUD-XX verifyBatch endpoint instead of one
 * request per invoice. Entries for endpoints without `verifyBatch` keep polling
 * per-invoice, exactly like today.
 *
 * That is the collapse the spec exists for: the pending set grows with each
 * send, but the number of verify requests stays one per endpoint per interval.
 * A settled invoice leaves the set; a deadline lapse fails it loud.
 */
export const pendingConfirmations = (() => {
  let entries = new Set<Entry>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;

  function settle(entry: Entry, status: VerifyStatus): void {
    if (!entries.has(entry)) return;
    entries.delete(entry);
    maybeStop();
    entry.onSettled(status);
  }

  function fail(entry: Entry, err: Error): void {
    if (!entries.has(entry)) return;
    entries.delete(entry);
    maybeStop();
    entry.onError(err);
  }

  function maybeStop(): void {
    if (timer && entries.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  async function tick(): Promise<void> {
    const now = Date.now();
    for (const entry of [...entries]) {
      if (now >= entry.deadline) fail(entry, new Error("receiver did not confirm settlement in time"));
    }

    // Batch group per verifyBatch endpoint; no endpoint → per-invoice suitability
    // handled by the payer surface itself (plain LUD-21 verify polling).
    const groups = new Map<string, Entry[]>();
    for (const entry of entries) {
      if (entry.soloPolling) continue;
      if (entry.verifyBatch === undefined) {
        entry.soloPolling = true;
        payer
          .pollVerify(entry.verifyUrl, { intervalMs: POLL_MS, timeoutMs: entry.deadline - now })
          .then((status) => settle(entry, status))
          .catch((err: unknown) => fail(entry, err as Error));
        continue;
      }
      const key = entry.verifyBatch;
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }

    for (const [endpoint, group] of groups) {
      try {
        const body = await batchVerify(endpoint, group.map((e) => e.verifyUrl));
        for (const entry of group) {
          const answer = body.results[entry.verifyUrl];
          if (answer.kind !== "verify") {
            fail(entry, new Error(answer.reason));
            continue;
          }
          if (answer.status.settled) settle(entry, answer.status);
        }
        // Unsettled entries simply await the next tick; a transport failure in
        // this iteration is retried on the next, and each entry still has its
        // own deadline catching a long outage.
      } catch {
        /* retry next tick */
      }
    }
  }

  function ensure(): void {
    if (timer) return;
    // A tick slower than the interval would otherwise overlap the next one.
    timer = setInterval(() => {
      if (ticking) return;
      ticking = true;
      void tick().finally(() => { ticking = false; });
    }, POLL_MS);
  }

  function forget(): void {
    entries = new Set();
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  return {
    /** Registers one pending confirmation and starts the shared loop. */
    add(confirmation: ReceiverConfirmation): void {
      const entry: Entry = {
        ...confirmation,
        deadline: Date.now() + (confirmation.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      };
      entries.add(entry);
      ensure();
    },
    /** Drops every pending entry; called on wallet Reset. */
    forget,
  };
})();
