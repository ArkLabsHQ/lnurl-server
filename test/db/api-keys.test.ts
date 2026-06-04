import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { DomainsRepo } from "../../src/db/repositories/domains.js";
import { ApiKeysRepo } from "../../src/db/repositories/api-keys.js";

let db: Db; let repo: ApiKeysRepo; let domainId: number;
beforeEach(() => {
  db = openDb(":memory:"); runMigrations(db);
  domainId = new DomainsRepo(db).create({ domain: "domain.com", allocationModes: ["self"] }).id;
  repo = new ApiKeysRepo(db);
});

describe("ApiKeysRepo", () => {
  it("creates a key (raw shown once) and verifies it", () => {
    const { raw } = repo.create({ label: "ci" });
    expect(raw).toMatch(/^[0-9a-f]{64}$/);
    expect(repo.verify(raw, domainId)).toBe(true);
    expect(repo.verify("wrong", domainId)).toBe(false);
  });

  it("scopes a domain-bound key to its domain only", () => {
    const other = new DomainsRepo(db).create({ domain: "other.com", allocationModes: ["self"] }).id;
    const { raw } = repo.create({ label: "scoped", domainId });
    expect(repo.verify(raw, domainId)).toBe(true);
    expect(repo.verify(raw, other)).toBe(false);
  });

  it("does not verify a revoked key", () => {
    const { raw, id } = repo.create({ label: "temp" });
    repo.revoke(id);
    expect(repo.verify(raw, domainId)).toBe(false);
  });
});
