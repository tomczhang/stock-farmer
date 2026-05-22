-- 开发环境种子数据：预置 watchlist，便于本地 pipeline / API 联调。
-- 在远程 D1 执行：
--   wrangler d1 execute stock-farmer --file=db/seed_watchlist.sql --remote
-- 在本地 D1 执行：
--   wrangler d1 execute stock-farmer --file=db/seed_watchlist.sql --local
--
-- 当前阵容：
--   * 纳指 7 姐妹 (Magnificent 7): AAPL / MSFT / NVDA / GOOGL / AMZN / META / TSLA
--   * 半导体: TSM (台积电 ADR)
--   * 价投经典: BRK.B (伯克希尔 B) / UNH (联合健康)
--   * 港股科技: 0700.HK (腾讯)

INSERT OR REPLACE INTO watchlist (ticker, market, added_at) VALUES
  -- 大盘指数
  ('SPX',     'INDEX', '2026-05-22T00:00:00Z'),
  -- 纳指 7 姐妹
  ('AAPL',    'US', '2026-05-22T00:00:00Z'),
  ('MSFT',    'US', '2026-05-22T00:00:00Z'),
  ('NVDA',    'US', '2026-05-22T00:00:00Z'),
  ('GOOGL',   'US', '2026-05-22T00:00:00Z'),
  ('AMZN',    'US', '2026-05-22T00:00:00Z'),
  ('META',    'US', '2026-05-22T00:00:00Z'),
  ('TSLA',    'US', '2026-05-22T00:00:00Z'),
  -- 半导体 / 价投经典
  ('TSM',     'US', '2026-05-22T00:00:00Z'),
  ('BRK.B',   'US', '2026-05-22T00:00:00Z'),
  ('UNH',     'US', '2026-05-22T00:00:00Z'),
  -- 港股
  ('0700.HK', 'HK', '2026-05-22T00:00:00Z');

-- 显式剔除阿里巴巴（保留 DELETE 痕迹便于 audit）
DELETE FROM watchlist WHERE ticker = '9988.HK';
