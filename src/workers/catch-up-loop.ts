export interface CatchUpLoop {
  /** Run a pass now; queued behind a running one rather than dropped. */
  trigger(): void;
  stop(): void;
}

/**
 * Run `pass` on demand with a catch-up behind it, never two at once. The next pass is
 * scheduled `intervalMs` after the last one finishes, so a slow source spaces passes
 * out. A trigger during a pass queues one more, because the running pass may have read
 * its source before whatever caused the trigger.
 *
 * A pass that throws or rejects goes to `onError` and the loop carries on: nothing
 * awaits a background pass, so an escaped rejection would take the process down.
 */
export function startCatchUpLoop(opts: {
  pass: () => Promise<unknown>;
  intervalMs: number;
  onError: (err: unknown) => void;
  /** Run the first pass now rather than one interval out. */
  immediate?: boolean;
}): CatchUpLoop {
  let inFlight = false;
  let queued = false;
  let stopped = false;
  let next: ReturnType<typeof setTimeout> | undefined;

  const schedule = (): void => {
    if (stopped) return;
    next = setTimeout(run, opts.intervalMs);
    // Don't keep the process alive just for the catch-up.
    next.unref?.();
  };
  const run = (): void => {
    if (stopped) return;
    inFlight = true;
    void Promise.resolve()
      .then(opts.pass)
      .catch(opts.onError)
      .finally(() => {
        inFlight = false;
        if (queued && !stopped) {
          queued = false;
          run();
          return;
        }
        schedule();
      });
  };
  const trigger = (): void => {
    if (stopped) return;
    if (inFlight) queued = true;
    else {
      if (next) clearTimeout(next);
      run();
    }
  };

  if (opts.immediate) run();
  else schedule();
  return {
    trigger,
    stop: () => {
      stopped = true;
      queued = false;
      if (next) clearTimeout(next);
    },
  };
}
