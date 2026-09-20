import type { WalletBalance } from "@arkade-os/sdk";

export interface BalanceView {
  sats: number | null;
  /** Committed to an in-flight intent; absent when there are none. */
  settling?: number;
}

/** `available` is `settled + preconfirmed - gated - intentLocked` and an offboard
 *  locks every VTXO it selects, so it reads 0 mid-batch without anything being wrong. */
export function balanceView(balance: WalletBalance | null): BalanceView {
  if (!balance) return { sats: null };
  const settling = balance.intentLocked;
  return typeof settling === "number" && settling > 0
    ? { sats: balance.available, settling }
    : { sats: balance.available };
}
