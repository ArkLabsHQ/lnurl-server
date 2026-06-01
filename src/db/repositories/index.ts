import type { Db } from "../connection.js";
import { DomainsRepo } from "./domains.js";
import { AddressesRepo } from "./addresses.js";
import { BlacklistRepo } from "./blacklist.js";
import { ApiKeysRepo } from "./api-keys.js";
import { WithdrawalsRepo } from "./withdrawals.js";

export interface Repositories {
  domains: DomainsRepo;
  addresses: AddressesRepo;
  blacklist: BlacklistRepo;
  apiKeys: ApiKeysRepo;
  withdrawals: WithdrawalsRepo;
}

export function createRepositories(db: Db): Repositories {
  return {
    domains: new DomainsRepo(db),
    addresses: new AddressesRepo(db),
    blacklist: new BlacklistRepo(db),
    apiKeys: new ApiKeysRepo(db),
    withdrawals: new WithdrawalsRepo(db),
  };
}
