import type { IContractManager } from "@arkade-os/sdk";
import { SWAP_LOCKUP_CONTRACT_TYPE } from "@arkade-os/swap";
import type { SettlementStore } from "../settlement-store.js";
import { COVENANT_CONTRACT_TYPE } from "../covenant/contract.js";
import { startCatchUpLoop, type CatchUpLoop } from "./catch-up-loop.js";

/** `retained` is the retired one: still readable, never subscribed or polled. */
export const LIVE_WATCH_STATES = ["watched", "awaiting-funds"] as const;

/** Retiring one contract re-posts the whole remaining subscription, so draining a
 *  backlog in a single pass is quadratic in script-slots. */
export const RETIRE_PER_PASS = 100;

/** Well under SQLite's parameter ceiling, which a payment burst could reach. */
const SCOPE_CHUNK = 500;

/** The manager's own filter type, which the package does not export by name. */
type ContractScope = NonNullable<Parameters<IContractManager["getContracts"]>[0]>;

/** The destinations still worth querying, as manager filters. Empty means nothing
 *  to do — not "everything", so a caller without a store must say so explicitly. */
export function activeCovenantFilters(store: SettlementStore): ContractScope[] {
  const scripts = store.listActiveCovenantScripts();
  const filters: ContractScope[] = [];
  for (let i = 0; i < scripts.length; i += SCOPE_CHUNK) {
    filters.push({ type: COVENANT_CONTRACT_TYPE, script: scripts.slice(i, i + SCOPE_CHUNK) });
  }
  return filters;
}

/** How many scripts a scope named; 0 for the unscoped fallback, which promises none. */
export function scopeSize(scope: ContractScope): number {
  return Array.isArray(scope.script) ? scope.script.length : 0;
}

/** The shortfall message for a pass, or undefined when every script resolved. Every
 *  active script was registered before its address went out, so resolving fewer means
 *  retained contracts stopped coming back and a sweep is being stranded silently. */
export function scopeShortfall(asked: number, found: number): string | undefined {
  return found < asked ? `resolved ${found} of ${asked} covenant destination(s)` : undefined;
}

/** Retire every live contract of one type whose script the service no longer works. */
async function retireOutside(
  contracts: IContractManager,
  type: string,
  active: Set<string>,
  rail: { name: string; unit: string },
  limit: number,
): Promise<number> {
  if (limit <= 0) return 0;
  const live = await contracts.getContracts({ type, watch: [...LIVE_WATCH_STATES] });
  const stale = live.filter((contract) => !active.has(contract.script));
  if (stale.length > limit) console.log(`${rail.name} retirement: ${stale.length} to retire, ${limit} per pass`);
  let retired = 0;
  for (const contract of stale.slice(0, limit)) {
    try {
      await contracts.setContractWatchState(contract.script, "retained");
      retired++;
    } catch (err) {
      // One row that will not move must not hold back the rest; the next pass retries.
      console.warn(`${rail.name} retirement: ${contract.script.slice(0, 16)}… stayed watched:`, err);
    }
  }
  if (retired > 0) console.log(`${rail.name} retirement: ${retired} ${rail.unit}(s) retired`);
  return retired;
}

/** One pass over the per-payment covenant destinations. */
export async function retireFinishedCovenants(
  store: SettlementStore,
  contracts: IContractManager,
  limit = RETIRE_PER_PASS,
): Promise<number> {
  const active = new Set(store.listActiveCovenantScripts());
  return retireOutside(contracts, COVENANT_CONTRACT_TYPE, active, { name: "covenant", unit: "destination" }, limit);
}

/** One pass over the offline-receive lockups. `registerLockupContract` writes no
 *  `watch`, which the SDK reads as `watched` and never demotes, so every offline
 *  invoice request left a script subscribed for the life of the process. */
export async function retireFinishedLockups(
  swaps: ActiveLockups,
  contracts: IContractManager,
  limit = RETIRE_PER_PASS,
): Promise<number> {
  const active = new Set(swaps.listActiveLockupScripts());
  return retireOutside(contracts, SWAP_LOCKUP_CONTRACT_TYPE, active, { name: "lockup", unit: "lockup" }, limit);
}

/** The slice of the offline-swap store retirement needs; optional for a caller
 *  without the offline rail. */
export interface ActiveLockups {
  listActiveLockupScripts(): string[];
}

export function startContractRetirement(
  store: SettlementStore,
  contracts: IContractManager,
  intervalMs: number,
  swaps?: ActiveLockups,
): CatchUpLoop {
  return startCatchUpLoop({
    // One budget across both rails: every retirement re-posts the whole subscription.
    pass: async () => {
      const retired = await retireFinishedCovenants(store, contracts);
      if (swaps) await retireFinishedLockups(swaps, contracts, RETIRE_PER_PASS - retired);
    },
    intervalMs,
    onError: (err) => console.warn("covenant retirement: pass failed; retrying:", err),
    immediate: true,
  });
}
