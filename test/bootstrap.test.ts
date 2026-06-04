import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { DomainsRepo } from "../src/db/repositories/domains.js";
import { BlacklistRepo } from "../src/db/repositories/blacklist.js";
import { bootstrap, DEFAULT_GLOBAL_BLACKLIST } from "../src/bootstrap.js";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
});

describe("bootstrap", () => {
  it("seeds the default global blacklist once", () => {
    bootstrap(db, { bootstrapDomain: undefined });
    const bl = new BlacklistRepo(db);
    for (const name of DEFAULT_GLOBAL_BLACKLIST) expect(bl.isBlocked(999, name)).toBe(true);
    bootstrap(db, { bootstrapDomain: undefined }); // idempotent
    expect(bl.list(null)).toHaveLength(DEFAULT_GLOBAL_BLACKLIST.length);
  });

  it("seeds the bootstrap domain when provided and absent", () => {
    bootstrap(db, { bootstrapDomain: "domain.com" });
    const d = new DomainsRepo(db).getByDomain("domain.com");
    expect(d?.allocationModes).toEqual(["self", "random"]);
  });

  it("does not duplicate an existing bootstrap domain", () => {
    bootstrap(db, { bootstrapDomain: "domain.com" });
    bootstrap(db, { bootstrapDomain: "domain.com" });
    expect(new DomainsRepo(db).list()).toHaveLength(1);
  });
});
