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

export interface SignalReportPoint {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SignalReportSignal {
  id: string;
  name: string;
  category: "left";
  confidence: number;
  confidence_pct: number;
  light: "red" | "yellow" | "green";
  light_label: string;
  thresholds: [number, number];
  weight: number;
  weight_label: string;
  description: string;
  data: Record<string, unknown>;
}

/** 轻量前瞻结果标签：仅作复盘 / 证伪展示，不参与 as-of 当天判断。 */
export interface ForwardOutcomeLabels {
  d5_pct: number | null;
  d10_pct: number | null;
  d20_pct: number | null;
  max_gain_20d_pct: number | null;
  max_drawdown_20d_pct: number | null;
}

export interface ReportContext {
  mode: "current" | "historical";
  requested_as_of: string | null;
  effective_date: string | null;
  data_start_date: string | null;
  data_end_date: string | null;
  trend_window: number;
  used_historical_cutoff: boolean;
  volume_profile_mode: string;
  forward_outcomes: ForwardOutcomeLabels | null;
  rules_version: "2" | string;
}

export interface BottomingSignDimension {
  key: string;
  label: string;
  score: number;
  detail?: string;
  [extra: string]: unknown;
}

export interface BottomingSign {
  id: string;
  name: string;
  plain_name: string;
  score: number;
  score_pct: number;
  state: "absent" | "early" | "clear";
  state_label: string;
  description: string;
  dimensions: BottomingSignDimension[];
}

export interface BottomingBlock {
  tier:
    | "still_falling"
    | "early_signs"
    | "base_forming"
    | "base_ready"
    | "trend_running";
  tier_label: string;
  icon: string;
  action: string;
  next_observation: string;
  /** 筑底结构强度，不代表胜率、概率或买点。 */
  cleanliness: number;
  cleanliness_pct: number;
  cleanliness_label: string;
  cleanliness_caption: string;
  regime?: "uptrend" | "downtrend" | "range" | "unknown";
  signs: BottomingSign[];
}

export interface BottomingHistoryPoint {
  date: string;
  close: number;
  normalized_close_pct: number;
  tier: BottomingBlock["tier"];
  tier_label: string;
  cleanliness_pct: number;
  sign_states: Record<string, BottomingSign["state"]>;
  sign_scores_pct: Record<string, number>;
  forward_returns: ForwardOutcomeLabels | null;
}

export interface BottomingHistory {
  window: number;
  points: BottomingHistoryPoint[];
}

export interface SignalReportResponse {
  schema_version: 2;
  ticker: string;
  name: string;
  price: number | null;
  change_pct: number | null;
  analyzed_at: string;
  conclusion: {
    tier: BottomingBlock["tier"];
    tier_label: string;
    icon: string;
    action: string;
    next_observation: string;
    structure_strength: number;
    structure_strength_pct: number;
    regime: "uptrend" | "downtrend" | "range" | "unknown";
  };
  bottoming: BottomingBlock;
  signals: SignalReportSignal[];
  narrative: string;
  chart_data: {
    klines: SignalReportPoint[];
    index_klines: Array<{ date: string; close: number }>;
    volume_profile: Array<{ price_level: number; volume: number; pct: number }>;
  };
  report_context: ReportContext;
  bottoming_history: BottomingHistory;
  disclaimer: string;
}

/* ---------- 金字塔交易回测 ---------- */

export interface PyramidTrade {
  date: string;
  action: "buy" | "add" | "trim" | "stop_loss";
  price: number;
  shares: number;
  amount: number;
  fee: number;
  tier?: number | null;
  tier_price?: number | null;
  reason: string;
}

export interface PyramidEvent {
  type: string;
  date: string;
  reason?: string;
  [extra: string]: unknown;
}

export interface PyramidLedgerRow {
  date: string;
  close: number;
  shares: number;
  net_cost: number | null;
  invested: number;
  recovered: number;
  position_value: number;
  unrealized: number | null;
}

export interface PyramidSummary {
  entered: boolean;
  not_entered: boolean;
  invested: number;
  recovered: number;
  shares: number;
  net_cost: number | null;
  negative_cost: boolean;
  end_value: number;
  end_value_note?: string | null;
  pnl: number;
  pnl_pct: number | null;
  stop_buy_triggered: boolean;
  trim_started: boolean;
  stop_loss_triggered: boolean;
  pending_orders: number;
  reason?: string;
}

export interface PyramidEntry {
  decision_date: string;
  mode: "manual";
  mode_label: string;
  bottoming_tier?: string;
  bottoming_tier_label?: string;
  cleanliness_pct?: number;
  fill_price: number | null;
  support: { price: number; source: string } | null;
  target: { price: number; source: "technical" | "fallback"; basis: string } | null;
}

export interface PyramidBacktestResponse {
  schema_version: 2;
  ticker: string;
  as_of: string;
  effective_date: string;
  window: { start: string; end: string; days: number };
  params: Record<string, unknown> & { stop_buy_progress?: number };
  entry: PyramidEntry | null;
  trades: PyramidTrade[];
  events: PyramidEvent[];
  pending_orders: Array<{ action: string; reason: string; note: string }>;
  ledger_series: PyramidLedgerRow[];
  summary: PyramidSummary;
  verdict_context: Record<string, unknown> | null;
  chart_data: { klines: SignalReportPoint[] };
  assumptions: string[];
  disclaimer: string;
  demo?: boolean;
}
