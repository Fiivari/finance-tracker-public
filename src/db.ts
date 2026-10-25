// SQLite storage via Node's built-in node:sqlite. Money is integer cents, dates are ISO strings.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

// Append-only: each entry runs once, tracked by PRAGMA user_version. Never edit an applied migration.
const MIGRATIONS = [
  `
  CREATE TABLE accounts (
    id          INTEGER PRIMARY KEY,
    uid         TEXT NOT NULL UNIQUE,      -- Enable Banking account uid (changes when consent is renewed)
    iban        TEXT UNIQUE,               -- stable across consents
    name        TEXT,
    product     TEXT,
    currency    TEXT NOT NULL,
    type        TEXT,                      -- cash_account_type: CACC current, SVGS savings, CARD credit card
    is_savings  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE bank_sessions (
    session_id  TEXT PRIMARY KEY,
    valid_until TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE transactions (
    id              INTEGER PRIMARY KEY,
    account_id      INTEGER NOT NULL REFERENCES accounts(id),
    entry_reference TEXT NOT NULL,
    booking_date    TEXT NOT NULL,
    amount          INTEGER NOT NULL,       -- signed cents, negative = money out
    currency        TEXT NOT NULL,
    counterparty    TEXT,
    description     TEXT,
    bank_code       TEXT,
    sub_code        TEXT,
    is_transfer     INTEGER NOT NULL DEFAULT 0,
    transfer_peer_id INTEGER REFERENCES transactions(id),
    raw             TEXT NOT NULL,
    first_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (account_id, entry_reference)
  );
  CREATE INDEX transactions_booking_date ON transactions (booking_date);

  CREATE TABLE balances_daily (
    account_id  INTEGER NOT NULL REFERENCES accounts(id),
    date        TEXT NOT NULL,
    booked      INTEGER,                    -- cents, ITBD
    available   INTEGER,                    -- cents, ITAV
    PRIMARY KEY (account_id, date)
  );

  CREATE TABLE sync_runs (
    id          INTEGER PRIMARY KEY,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    status      TEXT NOT NULL,              -- running | ok | error
    inserted    INTEGER NOT NULL DEFAULT 0,
    updated     INTEGER NOT NULL DEFAULT 0,
    error       TEXT
  );
  `,
  `
  CREATE TABLE categories (
    id    INTEGER PRIMARY KEY,
    name  TEXT NOT NULL UNIQUE,
    grp   TEXT NOT NULL CHECK (grp IN ('needs', 'wants', 'savings', 'income', 'transfer')),
    icon  TEXT
  );
  INSERT INTO categories (name, grp, icon) VALUES
    ('Groceries', 'needs', '🛒'), ('Eating out', 'wants', '🍽️'), ('Transport', 'needs', '🚌'),
    ('Housing', 'needs', '🏠'), ('Bills', 'needs', '🧾'), ('Subscriptions', 'wants', '🔁'),
    ('Shopping', 'wants', '🛍️'), ('Health', 'needs', '💊'), ('Entertainment', 'wants', '🎬'),
    ('Travel', 'wants', '✈️'), ('Income', 'income', '💶'), ('Savings', 'savings', '🐷'),
    ('Transfers', 'transfer', '🔄'), ('Other', 'wants', '📦');

  CREATE TABLE merchants (
    id              INTEGER PRIMARY KEY,
    key             TEXT NOT NULL UNIQUE,    -- lowercased normalized name
    name            TEXT NOT NULL,           -- display name ("K-Market")
    category_id     INTEGER REFERENCES categories(id),
    category_source TEXT                     -- user
  );

  -- User-defined rules: case-insensitive substring of counterparty + description.
  CREATE TABLE rules (
    id          INTEGER PRIMARY KEY,
    pattern     TEXT NOT NULL UNIQUE,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  ALTER TABLE transactions ADD COLUMN type TEXT;  -- card | card_refund | card_bill | cash | transfer_in | transfer_out | other
  ALTER TABLE transactions ADD COLUMN merchant_id INTEGER REFERENCES merchants(id);
  ALTER TABLE transactions ADD COLUMN category_id INTEGER REFERENCES categories(id);
  ALTER TABLE transactions ADD COLUMN category_source TEXT;  -- user | merchant | rule | type | transfer
  CREATE INDEX transactions_merchant ON transactions (merchant_id);

  -- Rebuilt by detectRecurring() after each sync.
  CREATE TABLE recurring (
    id                 INTEGER PRIMARY KEY,
    merchant_id        INTEGER NOT NULL REFERENCES merchants(id),
    kind               TEXT NOT NULL,        -- income | subscription | bill
    amount             INTEGER NOT NULL,     -- typical signed cents
    interval_days      INTEGER NOT NULL,
    occurrences        INTEGER NOT NULL,
    last_date          TEXT NOT NULL,
    next_expected_date TEXT NOT NULL,
    UNIQUE (merchant_id, kind)
  );
  `,
  `
  UPDATE categories SET name = 'Bars & eating out' WHERE name = 'Eating out';
  INSERT INTO categories (name, grp, icon) VALUES ('Gambling', 'wants', '🎰'), ('Loans', 'needs', '🏦');
  `,
  `
  ALTER TABLE bank_sessions ADD COLUMN data TEXT;  -- full POST /sessions response (JSON), written by the reconnect flow

  -- Passkeys (WebAuthn). Single user: every credential belongs to me.
  CREATE TABLE credentials (
    id           TEXT PRIMARY KEY,           -- credential id, base64url
    public_key   BLOB NOT NULL,              -- SPKI DER
    alg          INTEGER NOT NULL,           -- COSE algorithm: -7 ES256, -8 EdDSA, -257 RS256
    sign_count   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
  );

  -- Login sessions. Only a SHA-256 of the cookie token is stored.
  CREATE TABLE auth_sessions (
    token_hash   TEXT PRIMARY KEY,
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at   TEXT NOT NULL
  );
  `,
  `
  -- The web app (passkeys, login sessions) was shelved for the Google Sheets version.
  DROP TABLE credentials;
  DROP TABLE auth_sessions;
  `,
];

export function openDb(path = process.env.DB_PATH ?? "data/finance.db"): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const { user_version: current } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let version = current; version < MIGRATIONS.length; version++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
