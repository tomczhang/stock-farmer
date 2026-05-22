-- stock-farmer · D1 schema
--
-- 设计参见 openspec/changes/add-pe-percentile-viewer/design.md 决策 8。
-- 所有写入都使用 INSERT OR REPLACE 实现幂等，重复跑同一天的 pipeline 不会产生重复行。
--
-- 在远程 D1 执行：
--   wrangler d1 execute stock-farmer --file=db/schema.sql --remote
-- 在本地 D1 执行（供 wrangler dev 使用）：
--   wrangler d1 execute stock-farmer --file=db/schema.sql --local

-- ===== 1. prices · 日度复权收盘价 =====
-- 来源：Yahoo Finance stock_kline_yahoo (adjusted close)
-- 行数估算：200 ticker × 10 年 × 250 交易日 ≈ 50 万行
CREATE TABLE IF NOT EXISTS prices (
  ticker     TEXT NOT NULL,
  date       TEXT NOT NULL,       -- ISO 8601: YYYY-MM-DD
  close_adj  REAL NOT NULL,       -- 复权收盘价
  PRIMARY KEY (ticker, date)
);

CREATE INDEX IF NOT EXISTS idx_prices_ticker_date
  ON prices (ticker, date DESC);


-- ===== 2. eps_quarterly · 季度 EPS =====
-- 来源：East Money key_indicators_eastmoney (BASIC_EPS / DILUTED_EPS)
-- 行数估算：200 ticker × 40 季度 ≈ 8000 行
CREATE TABLE IF NOT EXISTS eps_quarterly (
  ticker       TEXT NOT NULL,
  period_end   TEXT NOT NULL,     -- ISO 8601: YYYY-MM-DD (季度结束日)
  eps_basic    REAL,              -- 可为 NULL（部分公司只披露 diluted）
  eps_diluted  REAL,              -- diluted 优先使用
  fetched_at   TEXT NOT NULL,     -- ISO 8601 timestamp，便于排查 "什么时候拉到的"
  PRIMARY KEY (ticker, period_end)
);


-- ===== 3. pe_series · 预计算的日度 PE-TTM 序列 =====
-- 由 pipeline 离线计算并写入；API 层只对此表做 SELECT。
-- is_loss=TRUE 表示该日 TTM EPS ≤ 0（亏损期），pe_ttm/percentile_* 均为 NULL。
-- 行数估算：与 prices 同量级 ≈ 50 万行
CREATE TABLE IF NOT EXISTS pe_series (
  ticker           TEXT NOT NULL,
  date             TEXT NOT NULL,
  pe_ttm           REAL,              -- 亏损期为 NULL
  percentile_5y    REAL,              -- 百分比 [0, 100]，亏损期为 NULL
  percentile_10y   REAL,
  percentile_all   REAL,
  is_loss          INTEGER NOT NULL DEFAULT 0,  -- 0 / 1（D1 没有 BOOLEAN 类型）
  PRIMARY KEY (ticker, date)
);

CREATE INDEX IF NOT EXISTS idx_pe_series_ticker_date
  ON pe_series (ticker, date DESC);


-- ===== 4. watchlist · 用户关注的股票列表 =====
-- MVP 单用户场景，没有 user_id 维度。
CREATE TABLE IF NOT EXISTS watchlist (
  ticker      TEXT PRIMARY KEY,
  market      TEXT NOT NULL,        -- 'US' | 'HK'
  added_at    TEXT NOT NULL         -- ISO 8601 timestamp
);


-- ===== 5. fetch_log · 增量拉取断点与诊断 =====
-- 每只股票 × 每种数据类型一行。
-- data_type ∈ {'prices', 'eps', 'pe_series', 'full_refresh'}
-- last_error / last_warning 用于决策 4 / 5 中的容错与对照校验。
CREATE TABLE IF NOT EXISTS fetch_log (
  ticker            TEXT NOT NULL,
  data_type         TEXT NOT NULL,
  last_fetched_at   TEXT,         -- ISO 8601 timestamp（成功或失败均更新）
  last_data_date    TEXT,         -- 拉到的最新一条数据日期（YYYY-MM-DD）
  last_error        TEXT,         -- 最近一次失败原因（成功后清空）
  last_warning      TEXT,         -- 例如 "PE diff with Yahoo > 10%"
  PRIMARY KEY (ticker, data_type)
);
