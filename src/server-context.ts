import type { Repositories } from "./db/repositories/index.js";
import type { AddressService } from "./services/addresses.js";
import type { RateLimiter } from "./rate-limit.js";
import type { SessionManager } from "./services/sessions.js";
import type { SettlementStore } from "./settlement-store.js";
import type { OfflineSwapCreator } from "./services/offline-swaps.js";
import type { OfflineSwapStore } from "./offline-swap-store.js";
import type { HealthRegistry } from "./health.js";
import type { Logger } from "./logger.js";
import type { ServerRailCaps } from "./rails.js";
import type { QuoteProvider } from "./quote-provider.js";
import type { CovenantDestinationProvider } from "./covenant-destination.js";
import type { RuntimeSettings } from "./services/settings.js";
import type { LnurlServiceConfig } from "./types/index.js";

export interface ServerDeps {
  repos: Repositories;
  addressService?: AddressService;
  registrationLimiter?: RateLimiter;
  sessions?: SessionManager;
  settings?: RuntimeSettings;
  settlements?: SettlementStore;
  /** When set, an offline LN address with a registered Arkade identity gets a
   *  server-orchestrated corridor swap instead of an "offline" error. */
  offlineSwapCreator?: OfflineSwapCreator;
  offlineSwaps?: OfflineSwapStore;
  /** When set, the arkade rail hands out a per-payment covenant address instead of the
   *  user's static one, so concurrent payments are told apart by script. */
  covenantDestinations?: CovenantDestinationProvider;
  /** When set, enables LUD-XX unit-denominated quotes (advertises `units`, quotes callbacks). */
  quoteProvider?: QuoteProvider;
  /** Solver discovery snapshot (when wired): the offline-swap rail reads readiness per request instead of blocking startup. */
  solverDiscovery?: { status(): { ready: boolean; reason?: string; receiveBounds?: { minSat: number; maxSat: number } } };
  /** Arkade indexer base URL (settlement observation for the arkade rail). */
  arkServerUrl?: string;
  /** Per-rail amount bounds, narrowing the server/domain pair for the rails that
   *  cannot carry it. Absent leaves every rail on the server/domain bounds. */
  railLimits?: ServerRailCaps["limits"];
  /** arkd's `dust`, sats. The floor the VTXO-settled rails actually face, which
   *  no operator setting can lower. @see withVtxoFloors */
  arkDustSat?: number;
  /** Economic floor for the onchain rail, sats. Policy, not protocol: delivering
   *  an onchain payment costs the payer a Bitcoin fee this server cannot see.
   *  Never lowers the rail below dust. @see withVtxoFloors */
  onchainMinSat?: number;
  /** Called with a static-rail destination as it is handed out, so a watcher can
   *  register it before the payer pays rather than on its next resync. */
  onDestinationIssued?: (destination: string) => void;
  health?: HealthRegistry;
  logger?: Logger;
}

/** What every public router shares, resolved once by `createServer`. */
export interface ServerContext extends Pick<ServerDeps,
  "addressService" | "registrationLimiter" | "offlineSwapCreator" | "offlineSwaps" | "covenantDestinations" | "quoteProvider" | "onDestinationIssued"
> {
  config: LnurlServiceConfig;
  /** Absent in library mode: no DB, so no Lightning addresses. */
  repos?: Repositories;
  sessions: SessionManager;
  store: SettlementStore;
  settings: RuntimeSettings;
  logger: Logger;
  currentRailCaps(): ServerRailCaps;
}
