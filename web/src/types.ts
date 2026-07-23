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

export interface SignalRightState {
  key: "default" | "warning-soft" | "warning" | "success";
  label: "未触发" | "酝酿中" | "临界" | "已触发";
}

export interface SignalReportSignal {
  id: string;
  name: string;
  category: "left" | "right";
  confidence: number;
  confidence_pct: number;
  light: "red" | "yellow" | "green";
  light_label: string;
  thresholds: [number, number];
  weight: number;
  weight_label: string;
  description: string;
  data: Record<string, unknown>;
  right_state: SignalRightState | null;
}

export interface SignalReportGroupSummary {
  key: "left" | "right";
  label: string;
  score: number;
  score_pct: number;
  weight: number;
  confirmed_count: number;
  total_count: number;
  /** 左侧=「左侧准备度」，右侧=「右侧触发度」 */
  role_label: string;
  /** 该侧分数代表什么的简短说明 */
  role_desc: string;
}

/**
 * 轻量前瞻结果标签：仅作复盘 / 证伪展示，绝不参与 as-of 当天判断。
 * 某个水平未来交易日不足时为 null。
 */
export interface ForwardOutcomeLabels {
  d5_pct: number | null;
  d10_pct: number | null;
  d20_pct: number | null;
  max_gain_20d_pct: number | null;
  max_drawdown_20d_pct: number | null;
}

/** 右侧趋势序列中的一个摘要点 */
export interface RightTrendPoint {
  date: string;
  close: number;
  /** 窗口内归一化收盘价 0~100，便于与确认度同轴叠放 */
  normalized_close_pct: number;
  /** 总结构强度百分比 */
  score_pct: number;
  /** 右侧触发度百分比 */
  right_score_pct: number;
  phase: string;
  right_confirmed_count: number;
  right_total_count: number;
  /** 每个右侧信号的 4 态 key */
  states: Record<string, "default" | "warning-soft" | "warning" | "success">;
  forward_returns: ForwardOutcomeLabels | null;
}

export interface RightTrend {
  window: number;
  points: RightTrendPoint[];
}

/** 历史复盘元数据：说明分析日期如何解析、用了哪段数据窗口 */
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
  rules_version: string;
}

export interface SignalReportResponse {
  ticker: string;
  name: string;
  price: number | null;
  change_pct: number | null;
  analyzed_at: string;
  conclusion: {
    phase: string;
    icon: string;
    action: string;
    trigger: string;
    strength: number;
    strength_pct: number;
    /** 价格趋势状态：uptrend / downtrend / range / unknown */
    regime?: "uptrend" | "downtrend" | "range" | "unknown";
  };
  confirmation: {
    score: number;
    score_pct: number;
    total_weight: number;
    formula: string;
    left: SignalReportGroupSummary;
    right: SignalReportGroupSummary;
    /** 总分语义标签：「结构强度」，非准确率 / 胜率 / 概率 */
    score_label: string;
    score_caption: string;
    /** 左右分层诊断文案 */
    diagnosis: string;
  };
  signals: SignalReportSignal[];
  groups: {
    left: SignalReportSignal[];
    right: SignalReportSignal[];
  };
  narrative: string;
  chart_data: {
    klines: SignalReportPoint[];
    index_klines: Array<{ date: string; close: number }>;
    volume_profile: Array<{
      price_level: number;
      volume: number;
      pct: number;
    }>;
  };
  report_context: ReportContext;
  right_trend: RightTrend;
  disclaimer: string;
}
