import { env } from "cloudflare:test";
import type { Env } from "../types";

/**
 * 测试种子 helper：
 *
 * 在每个测试 beforeEach 里调一次 `await resetAndSeed()`，把 schema 重建并塞入
 * 一份最小可用的 fixture（2 个 watchlist ticker、AAPL 3 行 pe_series 含一行亏损、
 * 一行 fetch_log）。
 *
 * 之所以每次都重建表而不依赖隔离存储自动清空：vitest-pool-workers 的
 * `isolatedStorage` 是按测试文件隔离，单文件内的多个 test 会共享 D1。手动 DROP +
 * CREATE 简单粗暴且行为可预期。
 */
declare module "cloudflare:test" {
  // 让 `env` 在测试代码里有正确类型
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface ProvidedEnv extends Env {}
}

const SCHEMA = [
  `DROP TABLE IF EXISTS prices`,
  `DROP TABLE IF EXISTS eps_quarterly`,
  `DROP TABLE IF EXISTS pe_series`,
  `DROP TABLE IF EXISTS watchlist`,
  `DROP TABLE IF EXISTS fetch_log`,
  `CREATE TABLE prices (
     ticker TEXT NOT NULL,
     date TEXT NOT NULL,
     close_adj REAL NOT NULL,
     PRIMARY KEY (ticker, date)
   )`,
  `CREATE TABLE eps_quarterly (
     ticker TEXT NOT NULL,
     period_end TEXT NOT NULL,
     eps_basic REAL,
     eps_diluted REAL,
     fetched_at TEXT NOT NULL,
     PRIMARY KEY (ticker, period_end)
   )`,
  `CREATE TABLE pe_series (
     ticker TEXT NOT NULL,
     date TEXT NOT NULL,
     pe_ttm REAL,
     percentile_5y REAL,
     percentile_10y REAL,
     percentile_all REAL,
     is_loss INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (ticker, date)
   )`,
  `CREATE TABLE watchlist (
     ticker TEXT PRIMARY KEY,
     market TEXT NOT NULL,
     added_at TEXT NOT NULL
   )`,
  `CREATE TABLE fetch_log (
     ticker TEXT NOT NULL,
     data_type TEXT NOT NULL,
     last_fetched_at TEXT,
     last_data_date TEXT,
     last_error TEXT,
     last_warning TEXT,
     PRIMARY KEY (ticker, data_type)
   )`,
];

export async function resetSchema(): Promise<void> {
  for (const sql of SCHEMA) {
    await env.DB.prepare(sql).run();
  }
}

/**
 * 写入一份小而典型的 fixture：
 *   - watchlist:  ('AAPL', 'US')、('0700.HK', 'HK')
 *   - pe_series for AAPL:
 *       2024-01-01  pe=20  percentile_5y=10  is_loss=0
 *       2024-01-02  NULL   NULL              is_loss=1   ← 亏损期
 *       2024-01-03  pe=30  percentile_5y=80  is_loss=0
 *   - fetch_log: AAPL/pe_series 拉取时间戳
 */
export async function seed(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO watchlist (ticker, market, added_at) VALUES (?, ?, ?)`,
    ).bind("AAPL", "US", "2026-05-01T00:00:00Z"),
    env.DB.prepare(
      `INSERT INTO watchlist (ticker, market, added_at) VALUES (?, ?, ?)`,
    ).bind("0700.HK", "HK", "2026-05-02T00:00:00Z"),

    env.DB.prepare(
      `INSERT INTO pe_series (ticker, date, pe_ttm, percentile_5y, percentile_10y, percentile_all, is_loss)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind("AAPL", "2024-01-01", 20.0, 10.0, 12.0, 15.0, 0),
    env.DB.prepare(
      `INSERT INTO pe_series (ticker, date, pe_ttm, percentile_5y, percentile_10y, percentile_all, is_loss)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind("AAPL", "2024-01-02", null, null, null, null, 1),
    env.DB.prepare(
      `INSERT INTO pe_series (ticker, date, pe_ttm, percentile_5y, percentile_10y, percentile_all, is_loss)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind("AAPL", "2024-01-03", 30.0, 80.0, 75.0, 70.0, 0),

    env.DB.prepare(
      `INSERT INTO fetch_log (ticker, data_type, last_fetched_at, last_data_date)
       VALUES (?, ?, ?, ?)`,
    ).bind("AAPL", "pe_series", "2026-05-21T08:00:00Z", "2024-01-03"),
  ]);
}

export async function resetAndSeed(): Promise<void> {
  await resetSchema();
  await seed();
}
