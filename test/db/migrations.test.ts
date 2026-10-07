import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/connection.js";
import { LATEST_MIGRATION, MIGRATION_COUNT, runMigrations } from "../../src/db/migrations.js";

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

  it("blocks migration 9 while legacy offline swaps remain unsettled", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    db.exec("DROP TABLE offline_swaps; ALTER TABLE addresses DROP COLUMN disabled_rails; ALTER TABLE addresses DROP COLUMN boarding_address; DROP INDEX IF EXISTS idx_settlements_address_updated; ALTER TABLE settlements DROP COLUMN updated_at; DROP INDEX IF EXISTS idx_settlements_address; ALTER TABLE settlements DROP COLUMN address_id; ALTER TABLE settlements DROP COLUMN payout_reference; DELETE FROM schema_migrations WHERE version >= 9;");
    db.prepare("INSERT INTO settlements (payment_hash, pr, session_id, settled, preimage, swap_id, created_at) VALUES ('aa', 'lnbc1', 'offline:1', 0, 'bb', 'legacy-rfq', ?)").run(Date.now());
    expect(() => runMigrations(db)).toThrow(/upgrade blocked.*1 unsettled legacy offline swap/i);
    db.close();
  });

  it("allows migration 9 after legacy offline swaps expire", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    db.exec("DROP TABLE offline_swaps; ALTER TABLE addresses DROP COLUMN disabled_rails; ALTER TABLE addresses DROP COLUMN boarding_address; DROP INDEX IF EXISTS idx_settlements_address_updated; ALTER TABLE settlements DROP COLUMN updated_at; DROP INDEX IF EXISTS idx_settlements_address; ALTER TABLE settlements DROP COLUMN address_id; ALTER TABLE settlements DROP COLUMN payout_reference; DROP INDEX IF EXISTS uq_addresses_session_lnurl; ALTER TABLE addresses DROP COLUMN session_lnurl; DELETE FROM schema_migrations WHERE version >= 9;");
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

  it("migration 18 creates ff_orders with a unique order_id index", () => {
    const db = openDb(":memory:");
    runMigrations(db, { upToVersion: 18 });
    const cols = (db.prepare("SELECT name FROM pragma_table_info('ff_orders')").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual([
      "payment_hash", "order_id", "order_token", "ff_code", "asset", "unit", "deposit_address", "deposit_tag",
      "deposit_amount", "deposit_txid", "to_amount_sat", "status", "emergency_json", "expires_at", "created_at", "updated_at",
    ]);
    const index = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'uq_ff_orders_order_id'").get() as { sql: string };
    expect(index.sql).toMatch(/UNIQUE INDEX .*ff_orders\(order_id\)/);
    db.close();
  });

  it("migrations run clean from empty to 18", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    expect(LATEST_MIGRATION).toBe(18);
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v).toBe(18);
    db.close();
  });

  it("migrating a database already at 16 reaches 18 without touching settlements rows", () => {
    const db = openDb(":memory:");
    runMigrations(db, { upToVersion: 16 });
    db.prepare("INSERT INTO settlements (payment_hash, pr, session_id, settled, payment_option, created_at, updated_at) VALUES ('aa', 'lnbc1', 's', 1, 'lightning', 1000, 2000)").run();
    const before = db.prepare("SELECT * FROM settlements").all();
    runMigrations(db);
    expect(db.prepare("SELECT * FROM settlements").all()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM ff_orders").get()).toEqual({ n: 0 });
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
