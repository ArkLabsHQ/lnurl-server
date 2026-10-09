import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/connection.js";
import { LATEST_MIGRATION, MIGRATION_COUNT, runMigrations } from "../../src/db/migrations.js";
import { DbSettlementStore } from "../../src/settlement-store.js";

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
    expect(row.v).toBe(LATEST_MIGRATION);
    db.close();
  });

  it("is idempotent on re-run", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    const row = db.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get() as { c: number };
    expect(row.c).toBe(MIGRATION_COUNT);
    db.close();
  });

  it("applies a version a higher one already landed past", () => {
    const db = openDb(":memory:");
    const versions = () =>
      (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[])
        .map((r) => r.version);
    const indexes = () =>
      (db.prepare("SELECT name FROM pragma_index_list('settlements')").all() as { name: string }[])
        .map((r) => r.name);

    runMigrations(db, { upToVersion: 16 });
    expect(versions()).not.toContain(17);
    db.exec("CREATE TABLE other_branch_marker (id INTEGER PRIMARY KEY)");
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (18, ?)").run(1000);

    expect(() => runMigrations(db)).not.toThrow();

    expect(versions()).toContain(17);
    expect(versions().filter((v) => v === 18)).toEqual([18]);
    expect(indexes()).toContain("idx_settlements_active_covenants");
    expect(() => runMigrations(db)).not.toThrow();
    expect(versions().filter((v) => v === 17)).toEqual([17]);
    db.close();
  });

  // The reverted 13 recorded its version without adding the column; 14 adds it.
  it("never re-runs the burned version 13", () => {
    const db = openDb(":memory:");
    runMigrations(db, { upToVersion: 12 });
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (13, ?)").run(1000);

    expect(() => runMigrations(db)).not.toThrow();

    const columns = (db.prepare("SELECT name FROM pragma_table_info('settlements')").all() as { name: string }[])
      .map((c) => c.name);
    expect(columns).toContain("payout_reference");
    db.close();
  });

  it("adds the pending-swap index to a database already at 17", () => {
    const db = openDb(":memory:");
    const indexes = () =>
      (db.prepare("SELECT name FROM pragma_index_list('settlements')").all() as { name: string }[])
        .map((r) => r.name);

    runMigrations(db, { upToVersion: 17 });
    expect(indexes()).not.toContain("idx_settlements_pending_swaps_created");

    runMigrations(db);

    expect(indexes()).toContain("idx_settlements_pending_swaps_created");
    expect(indexes()).toContain("idx_settlements_pending_destinations");
    db.close();
  });

  it("indexes the static destinations already in a database at 19", () => {
    const db = openDb(":memory:");
    runMigrations(db, { upToVersion: 19 });
    const insert = "INSERT INTO settlements (payment_hash, pr, session_id, settled, payment_option, payment_destination, amount_msat, covenant_script, created_at) VALUES (?, '', 's', 0, 'arkade', ?, 1000, ?, ?)";
    db.prepare(insert).run("static", "tark1static", null, Date.now());
    db.prepare(insert).run("covenant", "tark1derived", "5120aa", Date.now());

    runMigrations(db);

    const indexes = (db.prepare("SELECT name FROM pragma_index_list('settlements')").all() as { name: string }[]).map((r) => r.name);
    expect(indexes).toContain("idx_settlements_pending_static_destinations");
    expect(new DbSettlementStore(db, 60_000).listPendingDestinations().map((d) => d.paymentHash)).toEqual(["static"]);
    db.close();
  });

  it("blocks migration 9 while legacy offline swaps remain unsettled", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    db.exec("DROP TABLE offline_swaps; ALTER TABLE addresses DROP COLUMN disabled_rails; ALTER TABLE addresses DROP COLUMN boarding_address; DROP INDEX IF EXISTS idx_settlements_address_updated; ALTER TABLE settlements DROP COLUMN updated_at; DROP INDEX IF EXISTS idx_settlements_address; ALTER TABLE settlements DROP COLUMN address_id; DROP INDEX IF EXISTS idx_settlements_active_covenants; DROP INDEX IF EXISTS idx_settlements_reference; DROP INDEX IF EXISTS idx_settlements_pending_destinations; DROP INDEX IF EXISTS idx_settlements_pending_swaps_created; ALTER TABLE settlements DROP COLUMN payout_reference; DELETE FROM schema_migrations WHERE version >= 9;");
    db.prepare("INSERT INTO settlements (payment_hash, pr, session_id, settled, preimage, swap_id, created_at) VALUES ('aa', 'lnbc1', 'offline:1', 0, 'bb', 'legacy-rfq', ?)").run(Date.now());
    expect(() => runMigrations(db)).toThrow(/upgrade blocked.*1 unsettled legacy offline swap/i);
    db.close();
  });

  it("allows migration 9 after legacy offline swaps expire", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    db.exec("DROP TABLE offline_swaps; ALTER TABLE addresses DROP COLUMN disabled_rails; ALTER TABLE addresses DROP COLUMN boarding_address; DROP INDEX IF EXISTS idx_settlements_address_updated; ALTER TABLE settlements DROP COLUMN updated_at; DROP INDEX IF EXISTS idx_settlements_address; ALTER TABLE settlements DROP COLUMN address_id; DROP INDEX IF EXISTS idx_settlements_active_covenants; DROP INDEX IF EXISTS idx_settlements_reference; DROP INDEX IF EXISTS idx_settlements_pending_destinations; DROP INDEX IF EXISTS idx_settlements_pending_swaps_created; ALTER TABLE settlements DROP COLUMN payout_reference; DROP INDEX IF EXISTS uq_addresses_session_lnurl; ALTER TABLE addresses DROP COLUMN session_lnurl; DELETE FROM schema_migrations WHERE version >= 9;");
    db.prepare("INSERT INTO settlements (payment_hash, pr, session_id, settled, preimage, swap_id, created_at) VALUES ('aa', 'lnbc1', 'offline:1', 0, 'bb', 'legacy-rfq', 8000)").run();

    expect(() => runMigrations(db, { legacySwapTtlMs: 1000, now: () => 10_000 })).not.toThrow();
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'offline_swaps'").get();
    expect(table).toBeTruthy();
    db.close();
  });

  // Existing rows matter: without the backfill, every payment already settled on
  // the static rail would stay unlabelled in its owner's wallet forever.
  it("backfills payout_reference only where the observed payment was the credit", () => {
    const db = openDb(":memory:");
    runMigrations(db, { upToVersion: 12 });
    const insert = "INSERT INTO settlements (payment_hash, pr, session_id, settled, payment_option, payment_reference, covenant_script, created_at) VALUES (?, '', 's', 1, 'arkade', ?, ?, 1000)";
    db.prepare(insert).run("static", "tx-a", null);
    db.prepare(insert).run("covenant", "covenant-tx", "0014beef");
    db.prepare(insert).run("unsettled", null, null);

    runMigrations(db);

    const at = (hash: string) =>
      (db.prepare("SELECT payout_reference AS p FROM settlements WHERE payment_hash = ?").get(hash) as { p: string | null }).p;
    expect(at("static")).toBe("tx-a");
    expect(at("covenant")).toBeNull();
    expect(at("unsettled")).toBeNull();
    db.close();
  });

  // What mutinynet actually was. A different migration shipped as version 13,
  // was deployed, and was then reverted in the source only — so the database
  // records 13, skips the payout_reference step forever, and `markObserved`
  // queries a column that is not there. That took settlement down and, because
  // it threw before the sweep trigger, every covenant sweep with it.
  it("adds payout_reference where version 13 was a different, reverted migration", () => {
    const db = openDb(":memory:");
    runMigrations(db, { upToVersion: 12 });
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (13, 1000)").run();
    const insert = "INSERT INTO settlements (payment_hash, pr, session_id, settled, payment_option, payment_reference, covenant_script, created_at) VALUES (?, '', 's', 1, 'arkade', ?, ?, 1000)";
    db.prepare(insert).run("static", "tx-a", null);

    runMigrations(db);

    const names = (db.prepare("SELECT name FROM pragma_table_info('settlements')").all() as { name: string }[]).map((c) => c.name);
    expect(names).toContain("payout_reference");
    expect((db.prepare("SELECT payout_reference AS p FROM settlements WHERE payment_hash = 'static'").get() as { p: string | null }).p).toBe("tx-a");
    db.close();
  });

  it("does not add payout_reference twice where version 13 already did", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    const names = (db.prepare("SELECT name FROM pragma_table_info('settlements')").all() as { name: string }[])
      .filter((c) => c.name === "payout_reference");
    expect(names).toHaveLength(1);
    db.close();
  });

  it("backfills updated_at from settled_at, else created_at", () => {
    const db = openDb(":memory:");
    runMigrations(db, { upToVersion: 15 });
    const insert = "INSERT INTO settlements (payment_hash, pr, session_id, settled, created_at, settled_at) VALUES (?, '', 's', ?, 1000, ?)";
    db.prepare(insert).run("pending", 0, null);
    db.prepare(insert).run("settled", 1, 5000);

    runMigrations(db);

    const at = (hash: string) =>
      (db.prepare("SELECT updated_at AS u FROM settlements WHERE payment_hash = ?").get(hash) as { u: number | null }).u;
    expect(at("pending")).toBe(1000);
    expect(at("settled")).toBe(5000);
    db.close();
  });

  it("replaces the bare address index with the cursor index", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_settlements_address%'").all() as { name: string }[])
      .map((i) => i.name);
    expect(indexes).toEqual(["idx_settlements_address_updated"]);
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
