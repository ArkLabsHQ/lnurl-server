import type { Db } from "./db/connection.js";
import { DomainsRepo } from "./db/repositories/domains.js";
import { BlacklistRepo } from "./db/repositories/blacklist.js";

// RFC-2142 mailbox names + sensitive operational names.
export const DEFAULT_GLOBAL_BLACKLIST = [
  "admin", "administrator", "root", "support", "abuse", "postmaster", "hostmaster",
  "webmaster", "security", "noc", "info", "sales", "billing", "help", "noreply",
];

/** Idempotently seed the default global blacklist and an optional first domain. */
export function bootstrap(db: Db, opts: { bootstrapDomain?: string }): void {
  const blacklist = new BlacklistRepo(db);
  if (blacklist.list(null).length === 0) {
    for (const username of DEFAULT_GLOBAL_BLACKLIST) {
      blacklist.add({ domainId: null, username, reason: "default reserved name" });
    }
  }

  if (opts.bootstrapDomain) {
    const domains = new DomainsRepo(db);
    if (!domains.getByDomain(opts.bootstrapDomain)) {
      domains.create({ domain: opts.bootstrapDomain, allocationModes: ["self", "random"] });
    }
  }
}
