import { describe, it, expect } from "vitest";
import { openDb } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { DbSettlementStore } from "../src/settlement-store.js";

/** A v10 database holding rows written by all three rail conventions. */
function seedLegacy() {
  const db = openDb(":memory:");
  runMigrations(db, { upToVersion: 10 });
  db.exec(`INSERT INTO domains (id, domain, allocation_modes, username_min_len, username_max_len,
           username_pattern, enabled, created_at, updated_at)
           VALUES (1, 'x.test', 'open', 1, 32, 'a-z0-9._-', 1, 0, 0)`);
  db.exec(`INSERT INTO addresses (id, domain_id, username, session_id, status, created_at, updated_at)
           VALUES (7, 1, 'alice', 'sess-alice', 'active', 0, 0)`);
  const ins = (hash: string, sessionId: string) =>
    db.exec(`INSERT INTO settlements (payment_hash, pr, session_id, settled, created_at, amount_msat, payment_option)
             VALUES ('${hash}', 'lnbc1', '${sessionId}', 0, 0, 1000, 'lightning')`);
  ins("h-relay", "sess-alice");
  ins("h-offline", "offline:7");
  ins("h-dest", "addr:7");
  ins("h-ephemeral", "some-random-session");
  return db;
}

const addressIds = (db: ReturnType<typeof openDb>) =>
  db.prepare("SELECT payment_hash, address_id FROM settlements ORDER BY payment_hash").all() as
    { payment_hash: string; address_id: number | null }[];

const EXPECTED = [
  { payment_hash: "h-dest", address_id: 7 },
  { payment_hash: "h-ephemeral", address_id: null },
  { payment_hash: "h-offline", address_id: 7 },
  { payment_hash: "h-relay", address_id: 7 },
];

describe("settlements.address_id", () => {
  it("backfills all three session_id conventions and leaves ephemeral rows null", () => {
    const db = seedLegacy();
    runMigrations(db); // applies v11, including the backfill
    expect(addressIds(db)).toEqual(EXPECTED);
  });

  // The version check already makes a re-run a no-op; the `address_id IS NULL`
  // guards are what protect a migration that died between statements. Replaying
  // the backfill directly is the only way to exercise that.
  it("is idempotent when the backfill statements are replayed", () => {
    const db = seedLegacy();
    runMigrations(db);
    const once = addressIds(db);
    db.exec(`
      UPDATE settlements SET address_id =
        (SELECT id FROM addresses WHERE addresses.session_id = settlements.session_id)
        WHERE address_id IS NULL
          AND EXISTS (SELECT 1 FROM addresses WHERE addresses.session_id = settlements.session_id);
      UPDATE settlements SET address_id = CAST(substr(session_id, 9) AS INTEGER)
        WHERE address_id IS NULL AND session_id LIKE 'offline:%';
      UPDATE settlements SET address_id = CAST(substr(session_id, 6) AS INTEGER)
        WHERE address_id IS NULL AND session_id LIKE 'addr:%';
    `);
    expect(addressIds(db)).toEqual(once);
  });

  // Addresses get deleted (domains cascade), so an `offline:<id>` row can name
  // one that no longer exists. Writing that id into a column with a foreign key
  // aborts the entire migration, taking the server down on startup.
  it("leaves orphaned rail rows null instead of failing the migration", () => {
    const db = openDb(":memory:");
    runMigrations(db, { upToVersion: 10 });
    db.exec(`INSERT INTO settlements (payment_hash, pr, session_id, settled, created_at, amount_msat, payment_option)
             VALUES ('orphan', 'lnbc1', 'offline:999', 0, 0, 1000, 'lightning')`);
    expect(() => runMigrations(db)).not.toThrow();
    const row = db.prepare("SELECT address_id FROM settlements WHERE payment_hash = 'orphan'").get() as
      { address_id: number | null };
    expect(row.address_id).toBeNull();
  });

  // A fresh database, not seedLegacy(): its backfilled rows also belong to
  // address 7, which would make this assert the seed rather than the query.
  it("listByAddress returns only that address's rows, oldest first", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    db.exec(`INSERT INTO domains (id, domain, allocation_modes, username_min_len, username_max_len,
             username_pattern, enabled, created_at, updated_at)
             VALUES (1, 'x.test', 'open', 1, 32, 'a-z0-9._-', 1, 0, 0)`);
    db.exec(`INSERT INTO addresses (id, domain_id, username, session_id, status, created_at, updated_at)
             VALUES (7, 1, 'alice', 'sess-alice', 'active', 0, 0)`);
    let now = 1000;
    const store = new DbSettlementStore(db, 86_400_000, () => now);
    store.create({ paymentHash: "b", pr: "lnbc1", sessionId: "sess-alice", amountMsat: 1000, addressId: 7 });
    now = 2000;
    store.create({ paymentHash: "a", pr: "lnbc2", sessionId: "sess-alice", amountMsat: 2000, addressId: 7 });
    now = 3000;
    store.create({ paymentHash: "c", pr: "lnbc3", sessionId: "other", amountMsat: 3000 });
    const got = store.listByAddress(7, 50);
    expect(got.map((r) => r.paymentHash)).toEqual(["b", "a"]);
    expect(got.every((r) => r.addressId === 7)).toBe(true);
    expect(store.listByAddress(7, 50, { since: 2000 }).map((r) => r.paymentHash)).toEqual(["a"]);
  });

  // The offline swap is the one rail the receiver is never online for, so an
  // unattributed row here is a payment the wallet can never reconcile. In DB
  // mode the write goes through OfflineSwapStore, not store.create, which is a
  // second INSERT that has to carry address_id too.
  it("persists the owning address through the offline-swap store", async () => {
    const db = openDb(":memory:");
    runMigrations(db);
    db.exec(`INSERT INTO domains (id, domain, allocation_modes, username_min_len, username_max_len,
             username_pattern, enabled, created_at, updated_at)
             VALUES (1, 'x.test', 'open', 1, 32, 'a-z0-9._-', 1, 0, 0)`);
    db.exec(`INSERT INTO addresses (id, domain_id, username, session_id, status, created_at, updated_at)
             VALUES (7, 1, 'alice', 'sess-alice', 'active', 0, 0)`);
    const { OfflineSwapStore } = await import("../src/offline-swap-store.js");
    const swaps = new OfflineSwapStore(db, 86_400_000);
    swaps.createAccepted({
      paymentHash: "swap1", pr: "lnbc1", sessionId: "offline:7", preimage: "ab".repeat(32),
      amountMsat: 1000, addressId: 7,
      recovery: {
        version: 1, rfqId: "rfq-1", solverName: "s", solverPubkey: "p", relays: [],
        lockupAddress: "ark1", expectedAmount: 1000,
      } as never,
    });
    const store = new DbSettlementStore(db, 86_400_000);
    expect(store.listByAddress(7, 50).map((r) => r.paymentHash)).toEqual(["swap1"]);
  });

  it("a payment through an ephemeral session LNURL has no owning address", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const store = new DbSettlementStore(db, 86_400_000);
    store.create({ paymentHash: "eph", pr: "lnbc9", sessionId: "live-session-id", amountMsat: 500 });
    expect(store.get("eph")!.addressId).toBeNull();
  });
});
