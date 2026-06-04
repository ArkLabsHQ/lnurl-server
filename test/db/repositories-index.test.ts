import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { createRepositories } from "../../src/db/repositories/index.js";

describe("createRepositories", () => {
  it("exposes domains, addresses, and blacklist repos", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const repos = createRepositories(db);
    expect(repos.domains).toBeDefined();
    expect(repos.addresses).toBeDefined();
    expect(repos.blacklist).toBeDefined();
    const d = repos.domains.create({ domain: "domain.com", allocationModes: ["self"] });
    expect(repos.domains.getByDomain("domain.com")?.id).toBe(d.id);
    db.close();
  });
});
