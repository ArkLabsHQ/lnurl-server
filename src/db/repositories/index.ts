import type { Db } from "../connection.js";
import { DomainsRepo } from "./domains.js";
import { AddressesRepo } from "./addresses.js";
import { BlacklistRepo } from "./blacklist.js";
import { ApiKeysRepo } from "./api-keys.js";
import { SettingsRepo } from "./settings.js";
import { SolverCardsRepo } from "./solver-cards.js";
import { SolverRegistryCacheRepo } from "./solver-registry-cache.js";
import { OwnerSetupsRepo } from "./owner-setups.js";

export interface Repositories {
  domains: DomainsRepo;
  addresses: AddressesRepo;
  blacklist: BlacklistRepo;
  apiKeys: ApiKeysRepo;
  settings: SettingsRepo;
  solverCards: SolverCardsRepo;
  solverRegistryCache: SolverRegistryCacheRepo;
  ownerSetups: OwnerSetupsRepo;
}

export function createRepositories(db: Db): Repositories {
  return {
    domains: new DomainsRepo(db),
    addresses: new AddressesRepo(db),
    blacklist: new BlacklistRepo(db),
    apiKeys: new ApiKeysRepo(db),
    settings: new SettingsRepo(db),
    solverCards: new SolverCardsRepo(db),
    solverRegistryCache: new SolverRegistryCacheRepo(db),
    ownerSetups: new OwnerSetupsRepo(db),
  };
}
