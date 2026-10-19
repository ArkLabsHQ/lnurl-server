import { createPendingConfirmations, verifyStatusIsFor, type VerifyBatchStream, type VerifyExpectation } from "@arkade-os/lnurl-client";
import { payer } from "./lnurl.js";

// Longer than a corridor swap can take (the solver's deadline is 660s), not a poll budget.
const WATCH_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 30_000;
const FOREIGN_ANSWER = "verify answered about a different payment";

export interface WatchHandlers { settled: () => void; gaveUp: (reason: string) => void }
export interface SettlementWatcher {
  add(verifyUrl: string, on: WatchHandlers, expect?: VerifyExpectation): void;
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
  const pending = new Map<string, { on: WatchHandlers; deadline: number; expect?: VerifyExpectation }>();
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
        if (!entry) return;
        const foreign = entry.expect !== undefined && !verifyStatusIsFor(status, entry.expect);
        if (!foreign && !status.settled) return;
        pending.delete(url);
        // The server closes a stream whose every URL is settled, so removing the last one would race that close.
        if (pending.size) send([], [url]);
        changed();
        if (foreign) entry.on.gaveUp(FOREIGN_ANSWER);
        else entry.on.settled();
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
    add(verifyUrl, on, expect) {
      if (stopped || pending.has(verifyUrl)) return;
      pending.set(verifyUrl, { on, deadline: Date.now() + (opts.timeoutMs ?? WATCH_MS), ...(expect ? { expect } : {}) });
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

export const pendingConfirmations = createPendingConfirmations(payer);
