import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { DomainsRepo } from "../../src/db/repositories/domains.js";

let db: Db;
let repo: DomainsRepo;

beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
  repo = new DomainsRepo(db);
});

describe("DomainsRepo", () => {
  it("creates and reads back a domain with parsed allocation modes", () => {
    const created = repo.create({ domain: "domain.com", allocationModes: ["self", "random"] });
    expect(created.id).toBeGreaterThan(0);
    const found = repo.getByDomain("domain.com");
    expect(found?.allocationModes).toEqual(["self", "random"]);
    expect(found?.requireApiKey).toBe(false);
    expect(found?.enabled).toBe(true);
    expect(found?.maxPerSession).toBeNull();
  });

  it("lowercases the domain on lookup", () => {
    repo.create({ domain: "domain.com", allocationModes: ["admin"] });
    expect(repo.getByDomain("DOMAIN.com")?.domain).toBe("domain.com");
  });

  it("updates policy fields", () => {
    const d = repo.create({ domain: "d.com", allocationModes: ["self"] });
    repo.update(d.id, { requireApiKey: true, maxPerSession: 3 });
    const found = repo.getByDomain("d.com");
    expect(found?.requireApiKey).toBe(true);
    expect(found?.maxPerSession).toBe(3);
  });

  it("lists and deletes", () => {
    repo.create({ domain: "a.com", allocationModes: ["self"] });
    repo.create({ domain: "b.com", allocationModes: ["self"] });
    expect(repo.list()).toHaveLength(2);
    const a = repo.getByDomain("a.com")!;
    repo.delete(a.id);
    expect(repo.list()).toHaveLength(1);
  });
});
