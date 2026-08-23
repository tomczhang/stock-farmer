import { useMemo } from "react";
import ReactECharts from "echarts-for-react";

import type {
  BottomingHistoryPoint,
  ForwardOutcomeLabels,
  SignalReportResponse,
  SignalReportSignal,
} from "../types";
import { BottomingVerdictPanel } from "./BottomingVerdictPanel";

interface SignalTrendReportProps {
  report: SignalReportResponse;
}

export function SignalTrendReport({ report }: SignalTrendReportProps) {
  return (
    <div className="signal-report">
      <section className="report-hero">
        <div className="report-identity">
          <div>
            <span className="section-label">筑底结构诊断 · 规则版本 2</span>
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

        <ReportContextBanner report={report} />
        <BottomingVerdictPanel bottoming={report.bottoming} />
        <PriceChart report={report} />
      </section>

      <section className="insight-band">
        <div>
          <span className="section-label">结构综述</span>
          <p>{report.narrative}</p>
        </div>
        <div className="next-trigger">
          <span>下一项观察</span>
          <strong>{report.conclusion.next_observation}</strong>
        </div>
      </section>

      <BottomingHistoryMirror report={report} />

      <section className="signal-table-section">
        <div className="section-heading-row">
          <div>
            <span className="section-label">证据明细</span>
            <h2>六项保留结构信号</h2>
          </div>
        </div>
        <div className="signal-table" role="table" aria-label="筑底证据明细">
          <div className="signal-table-head" role="row">
            <span>信号</span>
            <span>类别</span>
            <span>权重</span>
            <span>状态</span>
            <span>结构值</span>
          </div>
          {report.signals.map((signal) => (
            <SignalRow key={signal.id} signal={signal} />
          ))}
        </div>
      </section>

      <footer className="report-footer">
        <p>{report.disclaimer}</p>
        <p>筑底结构强度仅描述当前证据，不代表买入时机、胜率或上涨概率。</p>
      </footer>
    </div>
  );
}

function ReportContextBanner({ report }: SignalTrendReportProps) {
  const context = report.report_context;
  if (context.mode === "historical") {
    const adjusted =
      context.requested_as_of && context.requested_as_of !== context.effective_date
        ? `（请求 ${context.requested_as_of}，映射到最近交易日）`
        : "";
    return (
      <div className="context-banner historical">
        <strong>历史复盘 · 有效交易日 {context.effective_date}</strong>
        <span>{adjusted} 结论只使用该日及以前的数据。</span>
      </div>
    );
  }
  return (
    <div className="context-banner current">
      <strong>当前结构 · {context.effective_date ?? "最新交易日"}</strong>
      <span>报告聚焦筑底三迹象与结构稳定性。</span>
    </div>
  );
}

function PriceChart({ report }: SignalTrendReportProps) {
  const option = useMemo(() => {
    const rows = report.chart_data.klines;
    return {
      animation: false,
      tooltip: { trigger: "axis" },
      grid: { left: 52, right: 22, top: 24, bottom: 36 },
      xAxis: {
        type: "category",
        data: rows.map((row) => row.date),
        axisLabel: { hideOverlap: true },
      },
      yAxis: { type: "value", scale: true },
      series: [
        {
          name: "收盘价",
          type: "line",
          showSymbol: false,
          data: rows.map((row) => row.close),
          lineStyle: { color: "#2563eb", width: 2 },
          areaStyle: { color: "rgba(37,99,235,.08)" },
        },
      ],
    };
  }, [report.chart_data.klines]);

  return (
    <section className="chart-card">
      <div className="section-heading-row compact">
        <div><span className="section-label">价格位置</span><h2>日线收盘走势</h2></div>
      </div>
      <ReactECharts option={option} style={{ height: 320 }} notMerge />
    </section>
  );
}

function BottomingHistoryMirror({ report }: SignalTrendReportProps) {
  const points = report.bottoming_history.points;
  const option = useMemo(() => historyOption(points), [points]);
  return (
    <section className="trend-mirror-section" aria-label="筑底历史证伪镜">
      <div className="section-heading-row">
        <div>
          <span className="section-label">历史复盘 · 证伪镜</span>
          <h2>筑底结构强度与价格</h2>
          <p>每个点逐日截断计算；后续涨跌标签仅供事后核对。</p>
        </div>
      </div>
      {points.length ? (
        <ReactECharts option={option} style={{ height: 360 }} notMerge />
      ) : (
        <div className="chart-empty">暂无足够历史数据</div>
      )}
    </section>
  );
}

function historyOption(points: BottomingHistoryPoint[]) {
  return {
    animation: false,
    tooltip: {
      trigger: "axis",
      formatter: (items: Array<{ dataIndex: number }>) => {
        const point = points[items[0]?.dataIndex ?? 0];
        if (!point) return "";
        return [
          `<strong>${point.date}</strong>`,
          `筑底档位：${point.tier_label}`,
          `结构强度：${point.cleanliness_pct}%`,
          `收盘价：${point.close.toFixed(2)}`,
          ...formatForward(point.forward_returns),
        ].join("<br/>");
      },
    },
    legend: { data: ["筑底结构强度", "归一化价格"] },
    grid: { left: 48, right: 22, top: 44, bottom: 36 },
    xAxis: { type: "category", data: points.map((point) => point.date), axisLabel: { hideOverlap: true } },
    yAxis: { type: "value", min: 0, max: 100 },
    series: [
      { name: "筑底结构强度", type: "line", showSymbol: false, data: points.map((point) => point.cleanliness_pct), lineStyle: { color: "#15803d", width: 2 } },
      { name: "归一化价格", type: "line", showSymbol: false, data: points.map((point) => point.normalized_close_pct), lineStyle: { color: "#2563eb", width: 2 } },
    ],
  };
}

function SignalRow({ signal }: { signal: SignalReportSignal }) {
  return (
    <div className="signal-table-row" role="row">
      <span><strong>{signal.name}</strong><small>{signal.description}</small></span>
      <span>结构证据</span>
      <span>{signal.weight_label}</span>
      <span className={`light-label ${signal.light}`}>{signal.light_label}</span>
      <span>{signal.confidence_pct}%</span>
    </div>
  );
}

function formatForward(value: ForwardOutcomeLabels | null): string[] {
  if (!value) return [];
  const pct = (item: number | null) => item == null ? "—" : `${item >= 0 ? "+" : ""}${item.toFixed(1)}%`;
  return [
    `事后 5/10/20 日：${pct(value.d5_pct)} / ${pct(value.d10_pct)} / ${pct(value.d20_pct)}`,
    `事后 20 日最大涨幅/回撤：${pct(value.max_gain_20d_pct)} / ${pct(value.max_drawdown_20d_pct)}`,
  ];
}

function formatPrice(value: number | null) {
  return value == null ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatChange(value: number | null) {
  if (value == null) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function toneClass(value: number) {
  if (value > 0) return "tone-up";
  if (value < 0) return "tone-down";
  return "tone-flat";
}
