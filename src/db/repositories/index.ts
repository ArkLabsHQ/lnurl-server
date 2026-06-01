import type { Db } from "../connection.js";
import { DomainsRepo } from "./domains.js";
import { AddressesRepo } from "./addresses.js";
import { BlacklistRepo } from "./blacklist.js";

export interface Repositories {
  domains: DomainsRepo;
  addresses: AddressesRepo;
  blacklist: BlacklistRepo;
}

export function createRepositories(db: Db): Repositories {
  return {
    domains: new DomainsRepo(db),
    addresses: new AddressesRepo(db),
    blacklist: new BlacklistRepo(db),
  };
}
