import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS auth_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'register',
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_auth_codes_email ON auth_codes(email, created_at);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS statements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  broker TEXT NOT NULL,
  file_name TEXT NOT NULL,
  as_of TEXT NOT NULL,
  parsed_json TEXT NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_statements_user ON statements(user_id, broker, as_of);

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  statement_id INTEGER NOT NULL REFERENCES statements(id) ON DELETE CASCADE,
  as_of TEXT NOT NULL,
  broker TEXT NOT NULL,
  market TEXT NOT NULL,
  currency TEXT NOT NULL,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  quantity REAL NOT NULL,
  market_value REAL NOT NULL,
  cost_basis REAL,
  unrealized_gl REAL
);
CREATE INDEX IF NOT EXISTS idx_positions_user ON positions(user_id, broker, as_of);

CREATE TABLE IF NOT EXISTS cash_balances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  statement_id INTEGER REFERENCES statements(id) ON DELETE CASCADE,
  as_of TEXT NOT NULL,
  broker TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'parsed',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cash_user ON cash_balances(user_id, broker, currency);

CREATE TABLE IF NOT EXISTS pyramid_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  market TEXT NOT NULL,
  currency TEXT NOT NULL,
  base_price REAL NOT NULL,
  total_budget REAL NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plan_tiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES pyramid_plans(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  trigger_type TEXT NOT NULL,
  trigger_value REAL NOT NULL,
  alloc_type TEXT NOT NULL,
  alloc_value REAL NOT NULL,
  filled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tiers_plan ON plan_tiers(plan_id, seq);

CREATE TABLE IF NOT EXISTS quote_cache (
  symbol TEXT NOT NULL,
  market TEXT NOT NULL,
  price REAL NOT NULL,
  currency TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (symbol, market)
);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  broker TEXT NOT NULL,
  market TEXT NOT NULL,
  currency TEXT NOT NULL,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  side TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  quantity REAL NOT NULL,
  price REAL NOT NULL,
  fee REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(user_id, symbol, trade_date);

CREATE TABLE IF NOT EXISTS symbol_buckets (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  bucket TEXT NOT NULL,
  PRIMARY KEY (user_id, symbol)
);

CREATE TABLE IF NOT EXISTS cost_overrides (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  broker TEXT NOT NULL,
  symbol TEXT NOT NULL,
  cost_basis REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, broker, symbol)
);
`;

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      ALTER TABLE trades ADD COLUMN statement_id INTEGER REFERENCES statements(id) ON DELETE CASCADE;
      ALTER TABLE trades ADD COLUMN source_id TEXT;
      ALTER TABLE trades ADD COLUMN gross_amount REAL;
      ALTER TABLE trades ADD COLUMN bucket TEXT;
      ALTER TABLE trades ADD COLUMN cost_basis_disposed REAL;
      ALTER TABLE trades ADD COLUMN realized_gain_loss REAL;
      ALTER TABLE trades ADD COLUMN fx_to_usd REAL;

      ALTER TABLE pyramid_plans ADD COLUMN scenario_name TEXT;
      ALTER TABLE pyramid_plans ADD COLUMN template_weights_json TEXT;

      CREATE TABLE capital_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        statement_id INTEGER REFERENCES statements(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        event_date TEXT NOT NULL,
        broker TEXT,
        market TEXT,
        currency TEXT NOT NULL,
        symbol TEXT,
        name TEXT,
        amount REAL,
        quantity REAL,
        unit_cost REAL,
        fx_to_usd REAL,
        source TEXT NOT NULL DEFAULT 'manual',
        source_id TEXT,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_capital_events_user_date ON capital_events(user_id, event_date DESC);
      CREATE UNIQUE INDEX idx_capital_events_source
        ON capital_events(user_id, source, source_id) WHERE source_id IS NOT NULL;

      CREATE TABLE cash_flow_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        statement_id INTEGER REFERENCES statements(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        event_date TEXT NOT NULL,
        broker TEXT,
        market TEXT,
        currency TEXT NOT NULL,
        symbol TEXT,
        name TEXT,
        gross_amount REAL NOT NULL,
        tax_amount REAL NOT NULL DEFAULT 0,
        fee_amount REAL NOT NULL DEFAULT 0,
        fx_to_usd REAL,
        bucket TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        source_id TEXT,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_cash_flow_events_user_date ON cash_flow_events(user_id, event_date DESC);
      CREATE UNIQUE INDEX idx_cash_flow_events_source
        ON cash_flow_events(user_id, source, source_id) WHERE source_id IS NOT NULL;

      CREATE TABLE risk_settings (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        symbol_limit REAL NOT NULL DEFAULT 0.5,
        bucket_limit REAL NOT NULL DEFAULT 0.5,
        cash_floor REAL NOT NULL DEFAULT 0.3,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE bucket_budgets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        bucket TEXT NOT NULL,
        quarter TEXT NOT NULL,
        revision INTEGER NOT NULL,
        limit_amount REAL NOT NULL,
        currency TEXT NOT NULL,
        fx_to_usd REAL NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(user_id, bucket, quarter, revision)
      );
      CREATE INDEX idx_bucket_budgets_user_quarter ON bucket_budgets(user_id, quarter, bucket);

      CREATE TABLE instrument_buckets (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        market TEXT NOT NULL,
        symbol TEXT NOT NULL,
        bucket TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, market, symbol)
      );

      CREATE UNIQUE INDEX idx_trades_source
        ON trades(user_id, source, source_id) WHERE source_id IS NOT NULL;
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE capital_events ADD COLUMN bucket TEXT;
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE pyramid_plans ADD COLUMN estimated_fee REAL NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_notes_user ON notes(user_id, pinned DESC, updated_at DESC);
    `,
  },
  {
    version: 5,
    sql: `
      ALTER TABLE trades ADD COLUMN reason TEXT;
      ALTER TABLE pyramid_plans ADD COLUMN direction TEXT NOT NULL DEFAULT 'add';

      CREATE TABLE monthly_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        month TEXT NOT NULL,
        attribution TEXT NOT NULL DEFAULT '',
        mistakes TEXT NOT NULL DEFAULT '',
        improvements TEXT NOT NULL DEFAULT '',
        macro_note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(user_id, month)
      );
      CREATE INDEX idx_monthly_reviews_user ON monthly_reviews(user_id, month DESC);

      CREATE TABLE watchlist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        market TEXT NOT NULL,
        symbol TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        ref_high REAL,
        ref_high_date TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(user_id, market, symbol)
      );
      CREATE INDEX idx_watchlist_user ON watchlist(user_id, created_at DESC);
    `,
  },
];

export type AppDatabase = Database.Database;

function runMigrations(db: AppDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?");
  const record = db.prepare("INSERT INTO schema_migrations (version) VALUES (?)");
  const migrate = db.transaction((migration: (typeof MIGRATIONS)[number]) => {
    db.exec(migration.sql);
    record.run(migration.version);
  });
  for (const migration of MIGRATIONS) {
    if (!applied.get(migration.version)) migrate(migration);
  }
}

export function openDatabase(dbPath: string): AppDatabase {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  runMigrations(db);
  return db;
}
