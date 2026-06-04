import { useMemo, useState } from "react";
import ReactECharts from "echarts-for-react";

import type {
  SignalReportGroupSummary,
  SignalReportResponse,
  SignalReportSignal,
} from "../types";

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

      <section className="group-grid">
        <SignalGroupPanel
          summary={report.confirmation.left}
          signals={report.groups.left}
        />
        <SignalGroupPanel
          summary={report.confirmation.right}
          signals={report.groups.right}
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
          <span className="section-label">右侧趋势确认度</span>
          <h2>{report.conclusion.phase}</h2>
          <p>{report.conclusion.action}</p>
        </div>
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
        <span>{summary.label}</span>
        <strong>{summary.score_pct}%</strong>
      </div>
      <div className="meter-track">
        <span style={{ width: `${summary.score_pct}%` }} />
      </div>
      <p>
        {summary.confirmed_count}/{summary.total_count} 项确认 · 权重{" "}
        {summary.weight}
      </p>
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

function SignalGroupPanel({
  summary,
  signals,
}: {
  summary: SignalReportGroupSummary;
  signals: SignalReportSignal[];
}) {
  return (
    <article className="group-panel">
      <div className="panel-title-row">
        <div>
          <span className="section-label">{summary.label}</span>
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
