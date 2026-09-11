import { describe, expect, it } from "vitest";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { SolverRegistryCacheRepo } from "../../src/db/repositories/solver-registry-cache.js";

describe("SolverRegistryCacheRepo", () => {
  it("upserts one response body per registry URL and network", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const repo = new SolverRegistryCacheRepo(db);
    repo.put({ url: "https://registry.test/bitcoin.json", network: "bitcoin", body: "first", fetchedAt: 10 });
    repo.put({ url: "https://registry.test/bitcoin.json", network: "bitcoin", body: "second", fetchedAt: 20 });
    expect(repo.get("https://registry.test/bitcoin.json", "bitcoin")).toEqual({
      url: "https://registry.test/bitcoin.json", network: "bitcoin", body: "second", fetchedAt: 20,
    });
    expect(repo.get("https://registry.test/bitcoin.json", "mutinynet")).toBeUndefined();
    db.close();
  });
});
