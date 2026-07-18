import type { Db } from "./connection.js";

interface Migration {
  version: number;
  up: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE domains (
        id               INTEGER PRIMARY KEY,
        domain           TEXT NOT NULL UNIQUE,
        allocation_modes TEXT NOT NULL,
        require_api_key  INTEGER NOT NULL DEFAULT 0,
        max_per_session  INTEGER,
        username_min_len INTEGER NOT NULL DEFAULT 1,
        username_max_len INTEGER NOT NULL DEFAULT 32,
        username_pattern TEXT NOT NULL DEFAULT 'a-z0-9._-',
        min_sendable     INTEGER,
        max_sendable     INTEGER,
        enabled          INTEGER NOT NULL DEFAULT 1,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      );

      CREATE TABLE addresses (
        id               INTEGER PRIMARY KEY,
        domain_id        INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
        username         TEXT NOT NULL,
        session_id       TEXT,
        token_ciphertext BLOB,
        token_iv         BLOB,
        token_tag        BLOB,
        claim_code_hash  BLOB,
        status           TEXT NOT NULL,
        metadata         TEXT,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        UNIQUE(domain_id, username)
      );
      CREATE INDEX idx_addresses_session ON addresses(session_id);

      CREATE TABLE blacklist (
        id         INTEGER PRIMARY KEY,
        domain_id  INTEGER REFERENCES domains(id) ON DELETE CASCADE,
        username   TEXT NOT NULL,
        reason     TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(domain_id, username)
      );
      -- UNIQUE(domain_id, username) does not constrain global rows (NULL domain_id is
      -- distinct under SQLite), so enforce global-name uniqueness with a filtered index.
      CREATE UNIQUE INDEX uq_blacklist_global ON blacklist(username) WHERE domain_id IS NULL;

      CREATE TABLE api_keys (
        id           INTEGER PRIMARY KEY,
        key_hash     BLOB NOT NULL UNIQUE,
        label        TEXT,
        domain_id    INTEGER REFERENCES domains(id) ON DELETE CASCADE,
        status       TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        last_used_at INTEGER
      );
    `,
  },
  {
    version: 2,
    up: `
      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 3,
    up: `
      CREATE TABLE settlements (
        payment_hash TEXT PRIMARY KEY,
        pr           TEXT NOT NULL,
        session_id   TEXT NOT NULL,
        settled      INTEGER NOT NULL DEFAULT 0,
        preimage     TEXT,
        created_at   INTEGER NOT NULL,
        settled_at   INTEGER
      );
      CREATE INDEX idx_settlements_created ON settlements(created_at);
    `,
  },
  {
    version: 4,
    // Offline-receive swaps: the server holds the preimage from swap creation and
    // records the swap's RFQ id so the settlement poller can flip `verify` when the
    // solver reports it settled.
    up: `
      ALTER TABLE settlements ADD COLUMN swap_id TEXT;
      CREATE INDEX idx_settlements_pending_swaps ON settlements(swap_id) WHERE swap_id IS NOT NULL AND settled = 0;
    `,
  },
  {
    version: 5,
    // Per-address Arkade receive identity for offline receive: the public info the
    // server needs to quote a corridor swap paying an offline user (no user secret).
    up: `
      ALTER TABLE addresses ADD COLUMN arkade_address TEXT;
      ALTER TABLE addresses ADD COLUMN claim_public_key TEXT;
    `,
  },
  {
    version: 6,
    // LUD-XX paymentOptions: non-`pr` records (e.g. a direct Arkade destination). For
    // these the payment_hash column holds an opaque verify id and pr is "". payment_option
    // is null for legacy lightning records. payment_reference is filled once the service
    // observes settlement (via a follow-up Arkade watcher).
    up: `
      ALTER TABLE settlements ADD COLUMN payment_option TEXT;
      ALTER TABLE settlements ADD COLUMN payment_destination TEXT;
      ALTER TABLE settlements ADD COLUMN payment_reference TEXT;
    `,
  },
];

/** Apply all pending forward-only migrations inside a transaction each. */
export function runMigrations(db: Db): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);",
  );
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
  const current = row.v ?? 0;

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.up);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(m.version, Date.now());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
