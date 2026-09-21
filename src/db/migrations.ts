import type { Db } from "./connection.js";

interface Migration {
  version: number;
  up: string | ((db: Db) => void);
}

const hasColumn = (db: Db, table: string, column: string): boolean =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);

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
    // observes settlement (via a follow-up Arkade watcher); amount_msat is what it
    // correlates the observed payment against — without it an under-payment would
    // flip settled just the same.
    up: `
      ALTER TABLE settlements ADD COLUMN payment_option TEXT;
      ALTER TABLE settlements ADD COLUMN payment_destination TEXT;
      ALTER TABLE settlements ADD COLUMN payment_reference TEXT;
      ALTER TABLE settlements ADD COLUMN amount_msat INTEGER;
    `,
  },
  {
    version: 7,
    // Per-payment Arkade destinations. covenant_script is the attribution key and
    // the join to the SDK contract that owns everything else about the covenant —
    // its params, its vtxos and its watch state all live in `ark_contracts`.
    up: `
      ALTER TABLE settlements ADD COLUMN covenant_script TEXT;
      CREATE UNIQUE INDEX uq_settlements_covenant_script
        ON settlements(covenant_script) WHERE covenant_script IS NOT NULL;
    `,
  },
  {
    version: 8,
    up: `
      CREATE TABLE solver_cards (
        id         INTEGER PRIMARY KEY,
        label      TEXT NOT NULL,
        network    TEXT NOT NULL,
        card_json  TEXT NOT NULL,
        enabled    INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_solver_cards_network_enabled ON solver_cards(network, enabled);

      CREATE TABLE solver_registry_cache (
        url        TEXT NOT NULL,
        network    TEXT NOT NULL,
        body       TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (url, network)
      );
    `,
  },
  {
    version: 9,
    up: `
      CREATE TABLE offline_swaps (
        payment_hash    TEXT PRIMARY KEY REFERENCES settlements(payment_hash) ON DELETE CASCADE,
        rfq_id          TEXT NOT NULL UNIQUE,
        solver_name     TEXT NOT NULL,
        solver_pubkey   TEXT NOT NULL,
        relays_json     TEXT NOT NULL,
        recovery_version INTEGER NOT NULL,
        recovery_json  TEXT NOT NULL,
        lockup_address  TEXT NOT NULL,
        expected_amount INTEGER NOT NULL,
        created_at      INTEGER NOT NULL
      );
    `,
  },
  {
    version: 10,
    // Per-address rail policy: rail ids the operator disabled for one LN address.
    up: `
      ALTER TABLE addresses ADD COLUMN disabled_rails TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 11,
    // Settlements carry only session_id, and the three rails write three different
    // conventions into it, so payments cannot be attributed to an address. Each
    // backfill is guarded on address_id IS NULL, making a retried migration converge
    // rather than double-apply, and on the address still existing — an id parsed out
    // of an orphaned `offline:`/`addr:` row would otherwise violate the foreign key
    // and abort the whole migration. session_id is deliberately left untouched: it
    // is still the ownership key for POST /lnurl/session/:id/settled.
    up: `
      ALTER TABLE settlements ADD COLUMN address_id INTEGER REFERENCES addresses(id);
      CREATE INDEX idx_settlements_address ON settlements(address_id) WHERE address_id IS NOT NULL;

      UPDATE settlements SET address_id =
        (SELECT id FROM addresses WHERE addresses.session_id = settlements.session_id)
        WHERE address_id IS NULL
          AND EXISTS (SELECT 1 FROM addresses WHERE addresses.session_id = settlements.session_id);

      UPDATE settlements SET address_id = CAST(substr(session_id, 9) AS INTEGER)
        WHERE address_id IS NULL AND session_id LIKE 'offline:%'
          AND EXISTS (SELECT 1 FROM addresses
                      WHERE addresses.id = CAST(substr(settlements.session_id, 9) AS INTEGER));

      UPDATE settlements SET address_id = CAST(substr(session_id, 6) AS INTEGER)
        WHERE address_id IS NULL AND session_id LIKE 'addr:%'
          AND EXISTS (SELECT 1 FROM addresses
                      WHERE addresses.id = CAST(substr(settlements.session_id, 6) AS INTEGER));
    `,
  },
  {
    version: 12,
    // The onchain rail pays the user's Arkade boarding address. Nullable and
    // separate from arkade_address because the two are independent: a wallet may
    // register an Arkade identity without ever wanting to be paid on-chain, and
    // the rail is advertised only when this is set.
    up: `
      ALTER TABLE addresses ADD COLUMN boarding_address TEXT;
    `,
  },
  {
    version: 13,
    // The txid that credited the user's OWN address — not always the one observed,
    // since a covenant payment is credited by its later sweep and a swap by its
    // claim. Backfilled only for the static rail, where the two are the same.
    up: `
      ALTER TABLE settlements ADD COLUMN payout_reference TEXT;

      UPDATE settlements SET payout_reference = payment_reference
        WHERE payment_reference IS NOT NULL AND covenant_script IS NULL;
    `,
  },
  {
    version: 14,
    // Version 13 is burned: another migration shipped under it, was deployed, then
    // reverted in source, so databases that ran it skip 13 — and fresh ones have it.
    up: (db) => {
      if (hasColumn(db, "settlements", "payout_reference")) return;
      db.exec("ALTER TABLE settlements ADD COLUMN payout_reference TEXT;");
      db.exec(
        "UPDATE settlements SET payout_reference = payment_reference" +
        " WHERE payment_reference IS NOT NULL AND covenant_script IS NULL;",
      );
    },
  },
];

export const LATEST_MIGRATION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
export const MIGRATION_COUNT = MIGRATIONS.length;

/** Apply all pending forward-only migrations inside a transaction each. */
export function runMigrations(
  db: Db,
  options: { legacySwapTtlMs?: number; now?: () => number; upToVersion?: number } = {},
): void {
  const now = options.now ?? Date.now;
  const legacySwapTtlMs = options.legacySwapTtlMs ?? 86_400_000;
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);",
  );
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
  const current = row.v ?? 0;

  if (current >= 4 && current < 9) {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'offline_swaps'").get();
    if (!table) {
      const legacy = db.prepare(
        "SELECT COUNT(*) AS count FROM settlements WHERE swap_id IS NOT NULL AND settled = 0 AND created_at > ?",
      ).get(now() - legacySwapTtlMs) as { count: number };
      if (legacy.count > 0) {
        throw new Error(`upgrade blocked: ${legacy.count} unsettled legacy offline swap(s) must drain first`);
      }
    }
  }

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    if (options.upToVersion !== undefined && m.version > options.upToVersion) continue;
    db.exec("BEGIN");
    try {
      if (typeof m.up === "string") db.exec(m.up);
      else m.up(db);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(m.version, now());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
