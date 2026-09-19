// The per-payment covenant is a VHTLC whose sender and receiver are both the user,
// so the SDK's own handler already builds it, serializes it, and picks its spending
// paths — this module exists only to give the rail a contract type of its own.
//
// It cannot simply reuse the SDK's: `VHTLCV2ContractHandler.type` is "vhtlc-v2",
// which is also what the offline-swap lockups register under, and `ContractFilter`
// can select by script, state, type or watch state but not by label. Sharing the
// type would leave the covenant watcher, the sweeper and src/lockup-watcher.ts
// unable to tell one rail's contracts from the other's.

import { VHTLCV2ContractHandler } from "@arkade-os/sdk";

export const COVENANT_CONTRACT_TYPE = "lnurl-covenant-destination";

/** The SDK's VHTLC v2 handler under this rail's own type. Spreadable because it is
 *  a plain object whose `createScript` reaches its sibling through `this`, which the
 *  copy still satisfies. */
export const covenantDestinationHandler: typeof VHTLCV2ContractHandler = {
  ...VHTLCV2ContractHandler,
  type: COVENANT_CONTRACT_TYPE,
};
