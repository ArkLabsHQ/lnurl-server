import type { WalletBalance } from "@arkade-os/sdk";

export interface BalanceView {
  sats: number | null;
  /** Committed to an in-flight intent; absent when there are none. */
  settling?: number;
}

/** Inert as wired: the SDK reads intent locks from `config.storage.intentRepository`,
 *  which gets no IndexedDB default and this wallet does not pass one, so `intentLocked`
 *  is always 0 and `settling` never renders. Confirmed against a funded offboard. */
export function balanceView(balance: WalletBalance | null): BalanceView {
  if (!balance) return { sats: null };
  const settling = balance.intentLocked;
  return typeof settling === "number" && settling > 0
    ? { sats: balance.available, settling }
    : { sats: balance.available };
}
