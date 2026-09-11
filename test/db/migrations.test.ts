import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";

function tableNames(db = openDb(":memory:")) {
  runMigrations(db);
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  return { db, names: rows.map((r) => r.name) };
}

describe("runMigrations", () => {
  it("creates every table", () => {
    const { db, names } = tableNames();
    for (const t of ["schema_migrations", "domains", "addresses", "blacklist", "api_keys", "settings", "settlements", "solver_cards", "solver_registry_cache", "offline_swaps"]) {
      expect(names).toContain(t);
    }
    db.close();
  });

  it("records the applied version", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number };
    expect(row.v).toBe(9);
    db.close();
  });

  it("is idempotent on re-run", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    const row = db.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get() as { c: number };
    expect(row.c).toBe(9);
    db.close();
  });

  it("blocks migration 9 while legacy offline swaps remain unsettled", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    db.exec("DROP TABLE offline_swaps; DELETE FROM schema_migrations WHERE version = 9;");
    db.prepare("INSERT INTO settlements (payment_hash, pr, session_id, settled, preimage, swap_id, created_at) VALUES ('aa', 'lnbc1', 'offline:1', 0, 'bb', 'legacy-rfq', ?)").run(Date.now());
    expect(() => runMigrations(db)).toThrow(/upgrade blocked.*1 unsettled legacy offline swap/i);
    db.close();
  });

  it("allows migration 9 after legacy offline swaps expire", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    db.exec("DROP TABLE offline_swaps; DELETE FROM schema_migrations WHERE version = 9;");
    db.prepare("INSERT INTO settlements (payment_hash, pr, session_id, settled, preimage, swap_id, created_at) VALUES ('aa', 'lnbc1', 'offline:1', 0, 'bb', 'legacy-rfq', 8000)").run();

    expect(() => runMigrations(db, { legacySwapTtlMs: 1000, now: () => 10_000 })).not.toThrow();
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'offline_swaps'").get();
    expect(table).toBeTruthy();
    db.close();
  });
});
