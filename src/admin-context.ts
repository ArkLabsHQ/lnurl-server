import type { IndexerProvider } from "@arkade-os/sdk";
import type { Repositories } from "./db/repositories/index.js";
import type { AddressService } from "./address-service.js";
import type { SessionManager } from "./session-manager.js";
import type { SettingsService } from "./settings.js";
import type { AppConfig } from "./config.js";
import type { SettlementStore } from "./settlement-store.js";
import type { DiscoveryService } from "./solver-discovery.js";
import type { Logger } from "./logger.js";
import type { ServerRailCaps } from "./rails.js";

export interface AdminDeps {
  repos: Repositories;
  addressService: AddressService;
  sessions: SessionManager;
  settings: SettingsService;
  config: AppConfig;
  /** Settlement records view (offline swaps, destination payments, relay invoices). */
  settlements?: SettlementStore;
  discovery?: Pick<DiscoveryService, "status" | "refresh">;
  /** Arkade indexer, for the post-mortem reconcile. Absent disables that route
   *  rather than failing it, since every other admin read works without one. */
  indexer?: Pick<IndexerProvider, "getVtxos">;
  logger?: Logger;
}

/** Server rail capabilities: what this process wired (the operator view of "it all").
 *  Per-address states ride on the addresses list; policy edits go to /addresses/:id/rails. */
export function adminRailCaps({ config, discovery }: AdminDeps): ServerRailCaps {
  const status = discovery?.status();
  return {
    offlineSwapCreator: config.offlineReceive.enabled,
    discoveryReady: status?.ready ?? false,
    ...(status?.reason ? { discoveryReason: status.reason } : {}),
    ...(config.offlineReceive.arkServerUrl ? { arkServerUrl: config.offlineReceive.arkServerUrl } : {}),
    covenantDestinations: config.offlineReceive.covenantDestinations,
  };
}
