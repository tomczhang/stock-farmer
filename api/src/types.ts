/**
 * 共享类型定义。
 *
 * `Env` 由 wrangler.toml 中的 binding + var 推导而来：
 *   - `DB`             — D1 数据库（schema 见 db/schema.sql）
 *   - `ALLOWED_ORIGINS` — 逗号分隔的 CORS 白名单
 *
 * 业务响应类型与 specs/pe-analytics-api/spec.md 对齐。
 */

export interface Env {
  DB: D1Database;
  ALLOWED_ORIGINS: string;
}

/** PE 时间序列的一行（亏损期 pe_ttm 为 null、is_loss 为 true） */
export interface PEHistoryPoint {
  date: string;
  pe_ttm: number | null;
  is_loss: boolean;
}

/** PE 指标卡片 */
export interface MetricsCard {
  current_pe: number | null;
  median_pe: number | null;
  current_percentile: number | null;
  min_pe: number | null;
  max_pe: number | null;
  loss_ratio: number;
}

/**
 * 实时 quote（由 Workers 边缘从雪球拉取，独立于离线 pe_series）。
 *
 * - `pe_ttm` 是用 last_close 算的标准 PE（与 D1 里的日收盘 PE 同口径）；
 * - `pe_ttm_ext` 是用 `current_ext`（盘前/盘后）+ EPS 重算的 PE，仅在
 *   雪球返回 current_ext 时存在；
 * - `is_extended_hours` 标记 pe_ttm_ext 是否相对 pe_ttm 出现明显偏离
 *   （> 0.05%），用于前端区分是否处于盘前/盘后行情；
 * - 雪球失败时，整个 LiveQuote 字段为 null，主响应不受影响。
 */
export interface LiveQuote {
  pe_ttm: number;
  pe_ttm_ext: number | null;
  current_price: number;
  current_ext: number | null;
  is_extended_hours: boolean;
  snapshot_at: string;
  source: "xueqiu";
}

/** /api/pe-history 完整响应 */
export interface PEHistoryResponse {
  ticker: string;
  range: PERange;
  series: PEHistoryPoint[];
  metrics: MetricsCard;
  metadata: {
    data_source: "latest_filings";
    last_updated: string | null;
    caveats: string[];
  };
  live: LiveQuote | null;
}

/** watchlist 行 */
export interface WatchlistItem {
  ticker: string;
  market: "US" | "HK";
  added_at: string;
}

/** 统一错误响应 */
export interface ErrorResponse {
  error: string;
  message: string;
}

/** /api/health 响应 */
export interface HealthResponse {
  status: "ok";
  last_pipeline_run: string | null;
}

export type PERange = "5y" | "10y" | "all";

export const VALID_RANGES: readonly PERange[] = ["5y", "10y", "all"] as const;
export const VALID_MARKETS: readonly ("US" | "HK")[] = ["US", "HK"] as const;
