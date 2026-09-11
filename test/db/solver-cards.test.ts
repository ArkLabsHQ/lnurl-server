import { describe, expect, it } from "vitest";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { SolverCardsRepo } from "../../src/db/repositories/solver-cards.js";

describe("SolverCardsRepo", () => {
  it("creates, replaces, disables, and deletes a manual card", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const repo = new SolverCardsRepo(db, () => 100);
    const created = repo.create({ label: "primary", network: "bitcoin", cardJson: '{"name":"one"}' });
    expect(created).toEqual({
      id: 1, label: "primary", network: "bitcoin", cardJson: '{"name":"one"}',
      enabled: true, createdAt: 100, updatedAt: 100,
    });
    expect(repo.listEnabled("bitcoin")).toEqual([created]);

    expect(repo.replace(created.id, { label: "backup", network: "mutinynet", cardJson: '{"name":"two"}' }))
      .toEqual(expect.objectContaining({ label: "backup", network: "mutinynet", cardJson: '{"name":"two"}', updatedAt: 100 }));
    expect(repo.setEnabled(created.id, false)).toEqual(expect.objectContaining({ enabled: false }));
    expect(repo.listEnabled("mutinynet")).toEqual([]);
    expect(repo.delete(created.id)).toBe(true);
    expect(repo.get(created.id)).toBeUndefined();
    db.close();
  });
});
