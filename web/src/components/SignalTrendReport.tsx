import { useMemo, useState } from "react";
import ReactECharts from "echarts-for-react";

import type {
  ForwardOutcomeLabels,
  RightTrendPoint,
  SignalReportGroupSummary,
  SignalReportResponse,
  SignalReportSignal,
} from "../types";
import { BottomingVerdictPanel } from "./BottomingVerdictPanel";

interface SignalTrendReportProps {
  report: SignalReportResponse;
}

type GroupFilter = "all" | "left" | "right";

const FILTERS: Array<{ key: GroupFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "left", label: "左侧" },
  { key: "right", label: "右侧" },
];

export function SignalTrendReport({ report }: SignalTrendReportProps) {
  const [filter, setFilter] = useState<GroupFilter>("all");
  const visibleSignals = useMemo(() => {
    if (filter === "all") return report.signals;
    return report.signals.filter((signal) => signal.category === filter);
  }, [filter, report.signals]);

  return (
    <div className="signal-report">
      <section className="report-hero">
        <div className="report-identity">
          <div>
            <h1>{report.ticker}</h1>
            <p>{report.name}</p>
          </div>
          <div className="quote-strip" aria-label="行情摘要">
            <span className="quote-price">{formatPrice(report.price)}</span>
            <span className={toneClass(report.change_pct ?? 0)}>
              {formatChange(report.change_pct)}
            </span>
          </div>
        </div>

        <TrendFitBanner report={report} />
        <ReportContextBanner report={report} />

        {/* 筑底迹象判读：首屏主结论；旧 payload 缓存无 bottoming 时回退现有结论区 */}
        {report.bottoming ? (
          <BottomingVerdictPanel bottoming={report.bottoming} />
        ) : null}

        <div className="hero-grid">
          <ConfirmationPanel report={report} />
          <TrendChart report={report} />
        </div>
      </section>

      <section className="insight-band">
        <div>
          <span className="section-label">综述</span>
          <p>{report.narrative}</p>
        </div>
        <div className="next-trigger">
          <span>下一触发</span>
          <strong>{report.conclusion.trigger}</strong>
        </div>
      </section>

      <RightTrendMirror report={report} />

      <section className="group-grid">
        {/* 出手时机确认（右侧）优先，左侧降为明细参考 */}
        <SignalGroupPanel
          summary={report.confirmation.right}
          signals={report.groups.right}
          heading="出手时机确认"
        />
        <SignalGroupPanel
          summary={report.confirmation.left}
          signals={report.groups.left}
          heading="明细参考"
        />
      </section>

      <section className="signal-table-section">
        <div className="section-heading-row">
          <div>
            <span className="section-label">子信号明细</span>
            <h2>权重、确认度与状态</h2>
          </div>
          <div className="segmented-control" role="tablist" aria-label="信号筛选">
            {FILTERS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={filter === item.key ? "active" : ""}
                onClick={() => setFilter(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <div className="signal-table" role="table" aria-label="信号明细">
          <div className="signal-table-head" role="row">
            <span>信号</span>
            <span>类别</span>
            <span>权重</span>
            <span>状态</span>
            <span>确认度</span>
          </div>
          {visibleSignals.map((signal) => (
            <SignalRow key={signal.id} signal={signal} />
          ))}
        </div>
      </section>

      <footer className="report-disclaimer">
        <span>{report.disclaimer}</span>
        <span>分析时间 {formatDateTime(report.analyzed_at)}</span>
      </footer>
    </div>
  );
}

function ConfirmationPanel({ report }: SignalTrendReportProps) {
  const score = report.confirmation.score_pct;
  return (
    <article className="confirmation-panel">
      <div className="confirmation-top">
        <CircularScore value={score} />
        <div>
          <span className="section-label">
            {report.confirmation.score_label}（非准确率 / 胜率）
          </span>
          <h2>{report.conclusion.phase}</h2>
          <p>{report.conclusion.action}</p>
        </div>
      </div>

      <p className="score-caption">{report.confirmation.score_caption}</p>

      <div className="diagnosis-card">
        <span className="section-label">分层诊断</span>
        <strong>{report.confirmation.diagnosis}</strong>
      </div>

      <div className="formula-card">
        <span>{report.confirmation.formula}</span>
        <strong>
          {report.confirmation.left.score_pct}% × {report.confirmation.left.weight}
          权重 + {report.confirmation.right.score_pct}% ×{" "}
          {report.confirmation.right.weight}权重
        </strong>
      </div>

      <div className="summary-pair">
        <SummaryMeter summary={report.confirmation.left} />
        <SummaryMeter summary={report.confirmation.right} />
      </div>
    </article>
  );
}

const REGIME_FIT: Record<
  "uptrend" | "downtrend" | "range",
  { label: string; fit: string; tone: string; explanation: string }
> = {
  downtrend: {
    label: "📉 下跌趋势",
    fit: "适合",
    tone: "applicable",
    explanation: "正可用本工具观察是否出现缩量筑底与右侧反转信号。",
  },
  uptrend: {
    label: "📈 上升趋势中途",
    fit: "不适合",
    tone: "caution",
    explanation:
      "本工具只捕捉底部反转买点；该股已在上升趋势中，确认度偏低属正常，不代表看空。如需参与请用趋势跟随 / 回调策略。",
  },
  range: {
    label: "↔ 震荡 / 区间整理",
    fit: "谨慎",
    tone: "neutral",
    explanation: "处于震荡区间，关注是否逐步构筑底部后，再等右侧反转确认。",
  },
};

function TrendFitBanner({ report }: SignalTrendReportProps) {
  const regime = report.conclusion.regime;
  if (!regime || regime === "unknown") return null;
  const info = REGIME_FIT[regime];
  return (
    <div className={`trend-fit-banner ${info.tone}`} role="note">
      <div className="trend-fit-head">
        <span className="trend-fit-label">{info.label}</span>
        <span className="trend-fit-tag">本工具适用性：{info.fit}</span>
      </div>
      <p>{info.explanation}</p>
    </div>
  );
}

function ReportContextBanner({ report }: SignalTrendReportProps) {
  const ctx = report.report_context;
  // 当前分析模式不再渲染冗余上下文条；趋势状态/适用性由 TrendFitBanner 表达。
  if (!ctx || ctx.mode !== "historical") {
    return null;
  }
  const showRequested =
    ctx.requested_as_of && ctx.requested_as_of !== ctx.effective_date;
  return (
    <div className="context-banner historical" role="note">
      <span className="context-tag">历史复盘</span>
      <span>
        有效交易日 <strong>{ctx.effective_date}</strong>
        {showRequested ? `（请求日期 ${ctx.requested_as_of}，已对齐到最近交易日）` : ""}
        ，仅使用该日及之前的数据计算结论。
      </span>
    </div>
  );
}

function CircularScore({ value }: { value: number }) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - value / 100);
  return (
    <div className="score-ring" aria-label={`确认度 ${value}%`}>
      <svg viewBox="0 0 104 104" aria-hidden="true">
        <circle cx="52" cy="52" r={radius} className="score-ring-track" />
        <circle
          cx="52"
          cy="52"
          r={radius}
          className="score-ring-fill"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <span>{value}%</span>
    </div>
  );
}

function SummaryMeter({ summary }: { summary: SignalReportGroupSummary }) {
  return (
    <div className="summary-meter">
      <div className="meter-head">
        <span>{summary.role_label || summary.label}</span>
        <strong>{summary.score_pct}%</strong>
      </div>
      <div className="meter-track">
        <span style={{ width: `${summary.score_pct}%` }} />
      </div>
      <p>
        {summary.confirmed_count}/{summary.total_count} 项确认 · 权重{" "}
        {summary.weight}
      </p>
      {summary.role_desc ? (
        <p className="role-desc">{summary.role_desc}</p>
      ) : null}
    </div>
  );
}

function TrendChart({ report }: SignalTrendReportProps) {
  const option = useMemo(() => {
    const rows = report.chart_data.klines;
    const dates = rows.map((row) => row.date);
    const closes = rows.map((row) => row.close);
    const volumes = rows.map((row) => row.volume);
    return {
      animation: false,
      grid: [
        { left: 44, right: 18, top: 24, height: "58%" },
        { left: 44, right: 18, bottom: 28, height: "18%" },
      ],
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross" },
      },
      xAxis: [
        {
          type: "category",
          data: dates,
          boundaryGap: false,
          axisLine: { lineStyle: { color: "#d8dde7" } },
          axisLabel: { color: "#6f7a89", fontSize: 11 },
        },
        {
          type: "category",
          data: dates,
          gridIndex: 1,
          boundaryGap: false,
          axisLine: { show: false },
          axisLabel: { show: false },
          axisTick: { show: false },
        },
      ],
      yAxis: [
        {
          type: "value",
          scale: true,
          axisLabel: { color: "#6f7a89", fontSize: 11 },
          splitLine: { lineStyle: { color: "#edf0f5" } },
        },
        {
          type: "value",
          gridIndex: 1,
          axisLabel: { show: false },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: "收盘价",
          type: "line",
          data: closes,
          smooth: true,
          symbol: "none",
          lineStyle: { width: 2, color: "#2563eb" },
          areaStyle: { color: "rgba(37, 99, 235, 0.08)" },
          markLine: {
            symbol: "none",
            label: { color: "#16855a", fontSize: 11 },
            lineStyle: { color: "#16855a", type: "dashed" },
            data: [{ yAxis: closes[closes.length - 1], name: "当前价" }],
          },
        },
        {
          name: "成交量",
          type: "bar",
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: volumes,
          itemStyle: { color: "rgba(111, 122, 137, 0.24)" },
        },
      ],
    };
  }, [report.chart_data.klines]);

  return (
    <article className="chart-panel">
      <div className="panel-title-row">
        <div>
          <span className="section-label">价格趋势</span>
          <h2>趋势确认轨迹</h2>
        </div>
        <StatusChip tone="success" label="React 渲染" />
      </div>
      <ReactECharts option={option} style={{ height: 360 }} />
    </article>
  );
}

function RightTrendMirror({ report }: SignalTrendReportProps) {
  const points = report.right_trend?.points ?? [];

  const option = useMemo(() => {
    const dates = points.map((p) => p.date);
    const scores = points.map((p) => p.score_pct);
    const normalized = points.map((p) => p.normalized_close_pct);
    return {
      animation: false,
      grid: { left: 44, right: 18, top: 28, bottom: 36 },
      legend: {
        data: ["结构强度", "归一化价格"],
        top: 0,
        textStyle: { color: "#6f7a89", fontSize: 11 },
      },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "line" },
        formatter: (params: unknown) => trendTooltip(params, points),
      },
      xAxis: {
        type: "category",
        data: dates,
        boundaryGap: false,
        axisLine: { lineStyle: { color: "#d8dde7" } },
        axisLabel: { color: "#6f7a89", fontSize: 11 },
      },
      yAxis: {
        type: "value",
        min: 0,
        max: 100,
        axisLabel: { color: "#6f7a89", fontSize: 11, formatter: "{value}%" },
        splitLine: { lineStyle: { color: "#edf0f5" } },
      },
      series: [
        {
          name: "结构强度",
          type: "line",
          data: scores,
          smooth: true,
          symbol: "none",
          lineStyle: { width: 2, color: "#2563eb" },
          areaStyle: { color: "rgba(37, 99, 235, 0.08)" },
        },
        {
          name: "归一化价格",
          type: "line",
          data: normalized,
          smooth: true,
          symbol: "none",
          lineStyle: { width: 2, color: "#16855a", type: "dashed" },
        },
      ],
    };
  }, [points]);

  return (
    <section className="trend-mirror-section">
      <div className="section-heading-row">
        <div>
          <span className="section-label">复盘 / 证伪镜</span>
          <h2>右侧确认度 vs 价格走势</h2>
        </div>
        <span className="mirror-hint">
          用于校准判断是否领先、同步或滞后于价格，非预测 / 胜率 / 策略收益
        </span>
      </div>
      {points.length === 0 ? (
        <div className="trend-mirror-empty" role="note">
          暂无足够历史交易日构建趋势序列。
        </div>
      ) : (
        <ReactECharts
          option={option}
          style={{ height: 320, width: "100%" }}
          opts={{ renderer: "canvas" }}
          notMerge
        />
      )}
    </section>
  );
}

function trendTooltip(params: unknown, points: RightTrendPoint[]): string {
  const list = Array.isArray(params) ? params : [params];
  const first = list[0] as { dataIndex?: number } | undefined;
  const idx = first?.dataIndex ?? -1;
  const point = idx >= 0 ? points[idx] : undefined;
  if (!point) return "";
  const lines = [
    `<strong>${point.date}</strong>`,
    `收盘价 ${point.close.toFixed(2)}`,
    `结构强度 ${point.score_pct}% · 阶段 ${point.phase}`,
    `右侧触发度 ${point.right_score_pct}% · 已触发 ${point.right_confirmed_count}/${point.right_total_count}`,
  ];
  const fwd = point.forward_returns;
  if (fwd) {
    lines.push(`后续走势标签：${formatForward(fwd)}`);
  }
  return lines.join("<br/>");
}

function formatForward(fwd: ForwardOutcomeLabels): string {
  const parts: string[] = [];
  const push = (label: string, value: number | null) => {
    if (value !== null && Number.isFinite(value)) {
      parts.push(`${label} ${value >= 0 ? "+" : ""}${value.toFixed(1)}%`);
    }
  };
  push("5日", fwd.d5_pct);
  push("10日", fwd.d10_pct);
  push("20日", fwd.d20_pct);
  push("20日最高", fwd.max_gain_20d_pct);
  push("20日最大回撤", fwd.max_drawdown_20d_pct);
  return parts.length ? parts.join(" · ") : "未来交易日不足";
}

function SignalGroupPanel({
  summary,
  signals,
  heading,
}: {
  summary: SignalReportGroupSummary;
  signals: SignalReportSignal[];
  heading?: string;
}) {
  return (
    <article className="group-panel">
      <div className="panel-title-row">
        <div>
          <span className="section-label">
            {heading ? `${summary.label} · ${heading}` : summary.label}
          </span>
          <h2>
            {summary.score_pct}% <small>加权分</small>
          </h2>
        </div>
        <span className="weight-token">权重 {summary.weight}</span>
      </div>
      <div className="compact-signal-list">
        {signals.map((signal) => (
          <SignalMiniRow key={signal.id} signal={signal} />
        ))}
      </div>
    </article>
  );
}

function SignalMiniRow({ signal }: { signal: SignalReportSignal }) {
  return (
    <div className="mini-row">
      <div>
        <strong>{signal.name}</strong>
        <span>{signal.description}</span>
      </div>
      <div className="mini-row-score">
        <StatusChip
          tone={signalTone(signal)}
          label={signal.right_state?.label ?? signal.light_label}
        />
        <span>{signal.confidence_pct}%</span>
      </div>
    </div>
  );
}

function SignalRow({ signal }: { signal: SignalReportSignal }) {
  return (
    <div className="signal-table-row" role="row">
      <div className="signal-name-cell">
        <strong>{signal.name}</strong>
        <span>{signal.description}</span>
      </div>
      <span className="signal-field-cell" data-label="类别">
        {signal.category === "left" ? "左侧" : "右侧"}
      </span>
      <span className="signal-field-cell" data-label="权重">
        <span className="weight-token">{signal.weight_label}</span>
      </span>
      <span className="signal-field-cell" data-label="状态">
        <StatusChip
          tone={signalTone(signal)}
          label={signal.right_state?.label ?? signal.light_label}
        />
      </span>
      <div className="confidence-cell" data-label="确认度">
        <strong>{signal.confidence_pct}%</strong>
        <div className="meter-track">
          <span style={{ width: `${signal.confidence_pct}%` }} />
        </div>
      </div>
    </div>
  );
}

function StatusChip({
  tone,
  label,
}: {
  tone: "default" | "warning" | "success" | "danger";
  label: string;
}) {
  return (
    <span className={`status-chip ${tone}`}>
      <i aria-hidden="true" />
      {label}
    </span>
  );
}

function signalTone(
  signal: SignalReportSignal,
): "default" | "warning" | "success" | "danger" {
  if (signal.right_state) {
    if (signal.right_state.key === "success") return "success";
    if (signal.right_state.key === "default") return "default";
    return "warning";
  }
  if (signal.light === "green") return "success";
  if (signal.light === "yellow") return "warning";
  return "danger";
}

function formatPrice(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "N/A";
  return `$${value.toFixed(2)}`;
}

function formatChange(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "变化未知";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function toneClass(value: number): string {
  if (value > 0) return "quote-change positive";
  if (value < 0) return "quote-change negative";
  return "quote-change";
}

function formatDateTime(value: string): string {
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ts));
}
