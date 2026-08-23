import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import ReactECharts from "echarts-for-react";

import { getPyramidBacktest } from "../api";
import type {
  PyramidBacktestResponse,
  PyramidEvent,
  PyramidTrade,
} from "../types";

const ACTION_LABELS: Record<PyramidTrade["action"], string> = {
  buy: "建仓",
  add: "加仓",
  trim: "减仓",
  stop_loss: "止损清仓",
};

const EVENT_LABELS: Record<string, string> = {
  stop_buy: "🚫 停止买入红线",
  trim_start: "📤 倒金字塔减仓启动",
  stop_loss: "🛑 支撑失效止损",
  skip_buy: "⏭ 跳过买入",
};

/**
 * 金字塔纪律推演：用户手动选择决策日，次日开盘建立标准首仓，
 * 后续只按价格档位、红线、减仓和支撑止损规则执行。
 */
export function PyramidBacktestPanel() {
  const [tickerInput, setTickerInput] = useState("DEMO");
  const [asOfInput, setAsOfInput] = useState("");
  const [windowInput, setWindowInput] = useState("");
  const [result, setResult] = useState<PyramidBacktestResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const runBacktest = useCallback(
    async (ticker: string, asOf: string | null, windowDays: string) => {
      const normalized = ticker.trim().toUpperCase();
      if (!normalized) return;
      setLoading(true);
      setError(null);
      try {
        const data = await getPyramidBacktest(normalized, {
          demo: normalized === "DEMO",
          asOf: normalized === "DEMO" ? null : asOf,
          window: windowDays ? Number(windowDays) : undefined,
        });
        setResult(data);
      } catch (err) {
        setResult(null);
        setError(err instanceof Error ? err : new Error("回测失败"));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void runBacktest("DEMO", null, "");
  }, [runBacktest]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = tickerInput.trim().toUpperCase();
    if (normalized !== "DEMO" && !asOfInput) {
      setError(new Error("请选择回测起点日期（as-of），或输入 DEMO 查看演示"));
      return;
    }
    void runBacktest(tickerInput, asOfInput || null, windowInput);
  };

  return (
    <div className="pyramid-page">
      <section className="pyramid-form-card">
        <div>
          <span className="section-label">金字塔纪律推演</span>
          <h2>手动选择决策日，验证仓位纪律</h2>
          <p className="pyramid-form-hint">
            决策日次日开盘建首仓 · 价格档位递减加仓 · 停止买入红线 ·
            倒金字塔减仓 · 跌破支撑止损（日线数据最多约 5 年）
          </p>
        </div>
        <form className="ticker-form" onSubmit={handleSubmit}>
          <input
            value={tickerInput}
            onChange={(e) => setTickerInput(e.target.value)}
            placeholder="AAPL 或 0700.HK"
            aria-label="回测标的"
            spellCheck={false}
          />
          <input
            type="date"
            value={asOfInput}
            onChange={(e) => setAsOfInput(e.target.value)}
            aria-label="手动决策日期"
            title="系统不判断买点；次一交易日开盘建立标准首仓"
          />
          <input
            type="number"
            min={10}
            max={500}
            value={windowInput}
            onChange={(e) => setWindowInput(e.target.value)}
            placeholder="窗口(默认120)"
            aria-label="回测窗口交易日数"
            className="pyramid-window-input"
          />
          <button type="submit" className="primary-button" disabled={loading}>
            回测
          </button>
        </form>
      </section>

      {loading ? (
        <section className="state-panel">
          <h1>纪律推演中…</h1>
          <p>正在锚定决策日支撑、目标与后续价格档位。</p>
        </section>
      ) : null}
      {!loading && error ? (
        <section className="state-panel danger">
          <span className="section-label">回测失败</span>
          <h1>{error.message}</h1>
          <p className="hint">
            需本地运行 `python -m pipeline.server`；输入 DEMO 可查看演示剧本。
          </p>
        </section>
      ) : null}
      {!loading && !error && result ? <BacktestResult result={result} /> : null}
    </div>
  );
}

function BacktestResult({ result }: { result: PyramidBacktestResponse }) {
  const summary = result.summary;
  return (
    <>
      <SummaryCard result={result} />
      <AssumptionsStrip result={result} />
      {summary.entered ? (
        <>
          <EntryCard result={result} />
          <BacktestChart result={result} />
          <EventsCard events={result.events} />
          <TradesTable trades={result.trades} />
        </>
      ) : (
        <section className="state-panel">
          <span className="section-label">首仓未成交</span>
          <h1>{summary.reason ?? "手动决策日首仓未成交"}</h1>
          <p>决策窗口 {result.window.start} → {result.window.end}</p>
        </section>
      )}
    </>
  );
}

function SummaryCard({ result }: { result: PyramidBacktestResponse }) {
  const s = result.summary;
  const conclusion = !s.entered
    ? "首仓未成交"
    : s.stop_loss_triggered
      ? "支撑失效，止损清仓退出"
      : s.negative_cost
        ? "底仓已做成负成本"
        : s.trim_started
          ? "已分批止盈回收本金"
          : "持仓推演至窗口结束";
  const tone = s.stop_loss_triggered
    ? "danger"
    : s.entered
      ? "success"
      : "neutral";
  return (
    <section className={`pyramid-summary ${tone}`}>
      <div className="pyramid-summary-head">
        <div>
          <span className="section-label">
            {result.ticker} · 回测结论（as-of {result.effective_date}）
          </span>
          <h2>{conclusion}</h2>
        </div>
        <div className="pyramid-flags">
          {s.stop_buy_triggered ? <span className="flag warning">红线触发</span> : null}
          {s.stop_loss_triggered ? <span className="flag danger">止损退出</span> : null}
          {s.negative_cost ? <span className="flag success">负成本底仓</span> : null}
        </div>
      </div>
      <div className="pyramid-metrics">
        <Metric label="总投入" value={fmtMoney(s.invested)} />
        <Metric label="已收回" value={fmtMoney(s.recovered)} />
        <Metric label="窗口末估值" value={fmtMoney(s.end_value)} hint={s.end_value_note} />
        <Metric
          label="总盈亏"
          value={
            s.pnl_pct !== null
              ? `${fmtMoney(s.pnl)}（${s.pnl_pct >= 0 ? "+" : ""}${s.pnl_pct}%）`
              : fmtMoney(s.pnl)
          }
        />
        <Metric label="剩余底仓" value={`${s.shares} 股`} />
        <Metric
          label="底仓净成本"
          value={s.net_cost !== null ? s.net_cost.toFixed(4) : "—"}
        />
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string | null;
}) {
  return (
    <div className="pyramid-metric" title={hint ?? undefined}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function AssumptionsStrip({ result }: { result: PyramidBacktestResponse }) {
  return (
    <section className="pyramid-assumptions" role="note">
      <span className="section-label">执行假设</span>
      {result.assumptions.map((a) => (
        <span key={a} className="assumption-chip">
          {a}
        </span>
      ))}
      <span className="pyramid-disclaimer">{result.disclaimer}</span>
    </section>
  );
}

function EntryCard({ result }: { result: PyramidBacktestResponse }) {
  const entry = result.entry;
  if (!entry) return null;
  return (
    <section className="pyramid-entry">
      <span className="section-label">入场与锚点</span>
      <div className="pyramid-entry-grid">
        <div>
          手动决策日 <strong>{entry.decision_date ?? "—"}</strong>
          <small>用户选择日期，系统不判断买点</small>
        </div>
        <div>
          入场价 <strong>{entry.fill_price ?? "—"}</strong>
          <small>决策日次一交易日开盘成交</small>
        </div>
        <div>
          目标价 <strong>{entry.target?.price ?? "—"}</strong>
          <small>
            {entry.target?.source === "technical" ? "技术压力位" : "回退目标"}：
            {entry.target?.basis ?? ""}
          </small>
        </div>
        <div>
          止损锚 <strong>{entry.support?.price ?? "—"}</strong>
          <small>支撑来源 {entry.support?.source ?? "—"}，推演期内不移动</small>
        </div>
      </div>
    </section>
  );
}

function BacktestChart({ result }: { result: PyramidBacktestResponse }) {
  const option = useMemo(() => {
    const klines = result.chart_data.klines;
    const dates = klines.map((k) => k.date);
    const closes = klines.map((k) => k.close);
    const costRows = result.ledger_series.filter((r) => r.net_cost !== null);
    const buys = result.trades
      .filter((t) => t.action === "buy" || t.action === "add")
      .map((t) => ({ value: [t.date, t.price], trade: t }));
    const sells = result.trades
      .filter((t) => t.action === "trim" || t.action === "stop_loss")
      .map((t) => ({ value: [t.date, t.price], trade: t }));

    const entry = result.entry;
    const markLines: Array<Record<string, unknown>> = [];
    if (entry?.target?.price) {
      markLines.push({
        yAxis: entry.target.price,
        name: "目标价",
        lineStyle: { color: "#b7791f", type: "dashed" },
        label: { formatter: "目标价 {c}", color: "#b7791f", fontSize: 10 },
      });
    }
    const stopBuyProgress = result.params.stop_buy_progress ?? 0.8;
    if (entry?.target?.price && entry.fill_price) {
      const redline =
        entry.fill_price + (entry.target.price - entry.fill_price) * stopBuyProgress;
      markLines.push({
        yAxis: Number(redline.toFixed(2)),
        name: "停止买入红线",
        lineStyle: { color: "#c43d4b", type: "dashed" },
        label: { formatter: "红线 {c}", color: "#c43d4b", fontSize: 10 },
      });
    }
    if (entry?.support?.price) {
      markLines.push({
        yAxis: entry.support.price,
        name: "止损支撑",
        lineStyle: { color: "#2563eb", type: "dashed" },
        label: { formatter: "支撑 {c}", color: "#2563eb", fontSize: 10 },
      });
    }

    return {
      animation: false,
      grid: { left: 48, right: 20, top: 32, bottom: 32 },
      legend: {
        data: ["收盘价", "持仓净成本", "买入", "卖出"],
        top: 0,
        textStyle: { color: "#6f7a89", fontSize: 11 },
      },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross" },
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
        scale: true,
        axisLabel: { color: "#6f7a89", fontSize: 11 },
        splitLine: { lineStyle: { color: "#edf0f5" } },
      },
      series: [
        {
          name: "收盘价",
          type: "line",
          data: closes,
          smooth: true,
          symbol: "none",
          lineStyle: { width: 2, color: "#2563eb" },
          areaStyle: { color: "rgba(37, 99, 235, 0.06)" },
          markLine: {
            symbol: "none",
            silent: true,
            data: markLines,
          },
        },
        {
          name: "持仓净成本",
          type: "line",
          data: costRows.map((r) => [r.date, r.net_cost]),
          symbol: "none",
          lineStyle: { width: 2, color: "#16855a", type: "dotted" },
        },
        {
          name: "买入",
          type: "scatter",
          data: buys,
          symbol: "triangle",
          symbolSize: 12,
          itemStyle: { color: "#16855a" },
        },
        {
          name: "卖出",
          type: "scatter",
          data: sells,
          symbol: "triangle",
          symbolRotate: 180,
          symbolSize: 12,
          itemStyle: { color: "#c43d4b" },
        },
      ],
    };
  }, [result]);

  return (
    <section className="chart-panel pyramid-chart">
      <div className="panel-title-row">
        <div>
          <span className="section-label">推演轨迹</span>
          <h2>买卖点 · 成本线 · 纪律价位</h2>
        </div>
        <span className="mirror-hint">▲ 买入 ▼ 卖出 · 虚线为目标价 / 红线 / 支撑</span>
      </div>
      <ReactECharts option={option} style={{ height: 380 }} notMerge />
    </section>
  );
}

function EventsCard({ events }: { events: PyramidEvent[] }) {
  if (!events.length) return null;
  return (
    <section className="pyramid-events">
      <span className="section-label">纪律事件</span>
      <ul>
        {events.map((e, idx) => (
          <li key={`${e.type}-${e.date}-${idx}`}>
            <span className="event-date">{e.date}</span>
            <strong>{EVENT_LABELS[e.type] ?? e.type}</strong>
            <span className="event-reason">{e.reason ?? ""}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TradesTable({ trades }: { trades: PyramidTrade[] }) {
  return (
    <section className="signal-table-section">
      <div className="section-heading-row">
        <div>
          <span className="section-label">逐笔账本</span>
          <h2>成交明细（含手续费）</h2>
        </div>
      </div>
      <div className="signal-table pyramid-trades" role="table" aria-label="逐笔账本">
        <div className="signal-table-head" role="row">
          <span>成交日</span>
          <span>动作</span>
          <span>价格</span>
          <span>股数</span>
          <span>金额</span>
        </div>
        {trades.map((t, idx) => (
          <div className="signal-table-row" role="row" key={`${t.date}-${idx}`}>
            <div className="signal-name-cell">
              <strong>{t.date}</strong>
              <span>{t.reason}</span>
            </div>
            <span className="signal-field-cell" data-label="动作">
              <span className={`trade-chip ${t.action}`}>
                {ACTION_LABELS[t.action]}
              </span>
            </span>
            <span className="signal-field-cell" data-label="价格">
              {t.price}
            </span>
            <span className="signal-field-cell" data-label="股数">
              {t.shares}
            </span>
            <span className="signal-field-cell" data-label="金额">
              {fmtMoney(t.amount)}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function fmtMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
