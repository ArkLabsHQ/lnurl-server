import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { DomainsRepo } from "../../src/db/repositories/domains.js";
import { BlacklistRepo } from "../../src/db/repositories/blacklist.js";

let db: Db;
let repo: BlacklistRepo;
let domainId: number;

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
  domainId = new DomainsRepo(db).create({ domain: "domain.com", allocationModes: ["self"] }).id;
  repo = new BlacklistRepo(db);
});

describe("BlacklistRepo", () => {
  it("blocks a global username for any domain", () => {
    repo.add({ domainId: null, username: "admin" });
    expect(repo.isBlocked(domainId, "admin")).toBe(true);
    expect(repo.isBlocked(domainId, "ADMIN")).toBe(true); // case-insensitive
  });

  it("blocks a per-domain username only for that domain", () => {
    const other = new DomainsRepo(db).create({ domain: "other.com", allocationModes: ["self"] }).id;
    repo.add({ domainId, username: "boss" });
    expect(repo.isBlocked(domainId, "boss")).toBe(true);
    expect(repo.isBlocked(other, "boss")).toBe(false);
  });

  it("lists and removes", () => {
    const row = repo.add({ domainId: null, username: "root" });
    expect(repo.list(null).map((r) => r.username)).toContain("root");
    repo.remove(row.id);
    expect(repo.isBlocked(domainId, "root")).toBe(false);
  });

  it("rejects a duplicate global username (filtered unique index)", () => {
    repo.add({ domainId: null, username: "admin" });
    expect(() => repo.add({ domainId: null, username: "admin" })).toThrow();
  });
});
