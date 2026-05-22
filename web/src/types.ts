/**
 * 前端共享类型定义。与 api/src/types.ts、specs/pe-analytics-api/spec.md
 * 保持一致；任何字段调整需要前后端同步修改。
 */

export type TimeRange = "5y" | "10y" | "all";

export const TIME_RANGES: readonly TimeRange[] = ["5y", "10y", "all"] as const;

export type Market = "US" | "HK";

/** PE 时间序列的一行：亏损期 pe_ttm 为 null，is_loss=true */
export interface PEHistoryPoint {
  date: string;
  pe_ttm: number | null;
  is_loss: boolean;
}

/** 4 张指标卡片的原始数据 */
export interface MetricsCard {
  current_pe: number | null;
  median_pe: number | null;
  current_percentile: number | null;
  min_pe: number | null;
  max_pe: number | null;
  loss_ratio: number;
}

/**
 * 实时行情快照：来自雪球 quote 接口。
 * - pe_ttm: 基于 last_close 的 PE（与收盘 PE 同口径）。
 * - pe_ttm_ext: 基于 current_ext（盘前/盘后价）的 PE，无盘前/盘后行情时为 null。
 * - is_extended_hours: true 表示 pe_ttm_ext 与 pe_ttm 存在显著差异（处于盘前/盘后变动）。
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

/** /api/pe-history 的完整响应 */
export interface PEHistoryResponse {
  ticker: string;
  range: TimeRange;
  series: PEHistoryPoint[];
  metrics: MetricsCard;
  /** 雪球失败时为 null；前端用于补充"实时 PE"对照，不参与分位计算。 */
  live: LiveQuote | null;
  metadata: {
    data_source: "latest_filings";
    last_updated: string | null;
    caveats: string[];
  };
}

/** watchlist 行 */
export interface WatchlistItem {
  ticker: string;
  market: Market;
  added_at: string;
}

/** /api/health 响应 */
export interface HealthResponse {
  status: "ok";
  last_pipeline_run: string | null;
}

/** 后端统一错误响应体 */
export interface ApiErrorBody {
  error: string;
  message: string;
}
