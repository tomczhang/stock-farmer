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
`;

export type AppDatabase = Database.Database;

export function openDatabase(dbPath: string): AppDatabase {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
