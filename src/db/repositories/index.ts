import type { Db } from "../connection.js";
import { DomainsRepo } from "./domains.js";
import { AddressesRepo } from "./addresses.js";
import { BlacklistRepo } from "./blacklist.js";
import { ApiKeysRepo } from "./api-keys.js";
import { SettingsRepo } from "./settings.js";
import { SolverCardsRepo } from "./solver-cards.js";
import { SolverRegistryCacheRepo } from "./solver-registry-cache.js";
import { QuoteUnitsRepo } from "./quote-units.js";
import { ClaimCodesRepo } from "./claim-codes.js";

export interface Repositories {
  domains: DomainsRepo;
  addresses: AddressesRepo;
  claimCodes: ClaimCodesRepo;
  blacklist: BlacklistRepo;
  apiKeys: ApiKeysRepo;
  settings: SettingsRepo;
  solverCards: SolverCardsRepo;
  solverRegistryCache: SolverRegistryCacheRepo;
  quoteUnits: QuoteUnitsRepo;
  transaction<T>(fn: () => T): T;
}

export function createRepositories(db: Db): Repositories {
  return {
    domains: new DomainsRepo(db),
    addresses: new AddressesRepo(db),
    claimCodes: new ClaimCodesRepo(db),
    blacklist: new BlacklistRepo(db),
    apiKeys: new ApiKeysRepo(db),
    settings: new SettingsRepo(db),
    solverCards: new SolverCardsRepo(db),
    solverRegistryCache: new SolverRegistryCacheRepo(db),
    quoteUnits: new QuoteUnitsRepo(db),
    transaction<T>(fn: () => T): T {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
