import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";

// Undoes 9..13 so the guarded replay of 9 can be exercised on a v8 schema.
const ROLLBACK_TO_8 = [
  "DROP TABLE offline_swaps",
  "DROP TABLE covenant_commitments",
  "DROP TABLE swap_commitments",
  "ALTER TABLE addresses DROP COLUMN disabled_rails",
  "ALTER TABLE addresses DROP COLUMN boarding_address",
  "ALTER TABLE addresses DROP COLUMN covenant_scheme",
  "ALTER TABLE addresses DROP COLUMN covenant_profile",
  "DROP INDEX IF EXISTS idx_settlements_address",
  "ALTER TABLE settlements DROP COLUMN address_id",
  "ALTER TABLE settlements DROP COLUMN covenant_index",
  "ALTER TABLE settlements DROP COLUMN swap_index",
  "DELETE FROM schema_migrations WHERE version >= 9",
].join("; ") + ";";

function tableNames(db = openDb(":memory:")) {
  runMigrations(db);
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  return { db, names: rows.map((r) => r.name) };
}

describe("runMigrations", () => {
  it("creates every table", () => {
    const { db, names } = tableNames();
    for (const t of ["schema_migrations", "domains", "addresses", "blacklist", "api_keys", "settings", "settlements", "solver_cards", "solver_registry_cache", "offline_swaps", "covenant_commitments", "swap_commitments"]) {
      expect(names).toContain(t);
    }
    db.close();
  });

  it("records the applied version", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number };
    expect(row.v).toBe(13);
    db.close();
  });

  it("is idempotent on re-run", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    const row = db.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get() as { c: number };
    expect(row.c).toBe(13);
    db.close();
  });

  it("blocks migration 9 while legacy offline swaps remain unsettled", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    db.exec(ROLLBACK_TO_8);
    db.prepare("INSERT INTO settlements (payment_hash, pr, session_id, settled, preimage, swap_id, created_at) VALUES ('aa', 'lnbc1', 'offline:1', 0, 'bb', 'legacy-rfq', ?)").run(Date.now());
    expect(() => runMigrations(db)).toThrow(/upgrade blocked.*1 unsettled legacy offline swap/i);
    db.close();
  });

  it("allows migration 9 after legacy offline swaps expire", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    db.exec(ROLLBACK_TO_8);
    db.prepare("INSERT INTO settlements (payment_hash, pr, session_id, settled, preimage, swap_id, created_at) VALUES ('aa', 'lnbc1', 'offline:1', 0, 'bb', 'legacy-rfq', 8000)").run();

    expect(() => runMigrations(db, { legacySwapTtlMs: 1000, now: () => 10_000 })).not.toThrow();
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'offline_swaps'").get();
    expect(table).toBeTruthy();
    db.close();
  });

  it("adds the supply schema without touching rows already there", () => {
    const db = openDb(":memory:");
    runMigrations(db, { upToVersion: 12 });
    db.prepare("INSERT INTO domains (domain, allocation_modes, created_at, updated_at) VALUES ('d.example', '[\"self\"]', 1, 1)").run();
    db.prepare("INSERT INTO addresses (domain_id, username, status, created_at, updated_at) VALUES (1, 'alice', 'active', 1, 1)").run();
    db.prepare("INSERT INTO settlements (payment_hash, pr, session_id, settled, created_at, covenant_script) VALUES ('h1', '', 'addr:1', 0, 1, 'aa')").run();

    runMigrations(db);

    const address = db.prepare("SELECT * FROM addresses WHERE id = 1").get() as Record<string, unknown>;
    expect(address).toMatchObject({ username: "alice", covenant_scheme: null, covenant_profile: null });
    const settlement = db.prepare("SELECT * FROM settlements WHERE payment_hash = 'h1'").get() as Record<string, unknown>;
    expect(settlement).toMatchObject({ covenant_script: "aa", covenant_index: null });
    expect(db.prepare("SELECT COUNT(*) AS c FROM covenant_commitments").get()).toEqual({ c: 0 });
    db.close();
  });

  it("adds per-address rail policy defaulting to empty", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const cols = db.prepare("SELECT name, dflt_value AS d FROM pragma_table_info('addresses')").all() as { name: string; d: string }[];
    expect(cols.find((c) => c.name === "disabled_rails")?.d).toBe("'[]'");
    db.close();
  });
});
