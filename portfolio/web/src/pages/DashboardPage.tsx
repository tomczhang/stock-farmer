import type { EChartsOption } from "echarts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import { Chart, fmtCompact, fmtMoney, GAIN, HAIRLINE, LIGHT_TOOLTIP, LOSS, PALETTE } from "../components/Chart";
import { ValueFlash } from "../components/ValueFlash";
import { describeCoverageItems } from "../lib/portfolio/coverage";
import { aggregateSummaryPositions } from "../lib/portfolio/positions";
import { BUCKET_LABELS, type BucketBudget, type Currency, type RiskSettings, type Summary } from "../types";

const CCY_SIGN: Record<Currency, string> = { USD: "$", HKD: "HK$", CNY: "¥" };

function ratioText(value: number | null | undefined) {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function pnlText(sign: string, value: number | null | undefined) {
  if (value == null) return "—";
  return `${value >= 0 ? "+" : "-"}${sign}${fmtMoney(Math.abs(value), 0)}`;
}

function currentQuarter() {
  const now = new Date();
  return `${now.getFullYear()}-Q${Math.floor(now.getMonth() / 3) + 1}`;
}

export default function DashboardPage() {
  const [display, setDisplay] = useState<Currency>("USD");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [risk, setRisk] = useState<RiskSettings>({ symbolLimit: 0.5, bucketLimit: 0.5, cashFloor: 0.3 });
  const [budgets, setBudgets] = useState<BucketBudget[]>([]);
  const [busy, setBusy] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  // 分层视图：总览默认看全部资产（含授予仓），可切到自主组合
  const [scope, setScope] = useState<"all" | "self">("all");

  const load = useCallback(async (refresh = false) => {
    refresh ? setRefreshing(true) : setBusy(true);
    setError("");
    try {
      const [nextSummary, nextRisk, nextBudgets] = await Promise.all([
        api.get<Summary>(`/api/portfolio/summary?display=${display}${scope === "self" ? "&scope=self" : ""}${refresh ? "&refresh=1" : ""}`),
        api.get<RiskSettings>("/api/risk-settings"),
        api.get<{ quarter: string; budgets: BucketBudget[] }>(`/api/bucket-budgets?quarter=${currentQuarter()}`),
      ]);
      setSummary(nextSummary);
      setRisk(nextRisk);
      setBudgets(nextBudgets.budgets);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "资产总览加载失败");
    } finally {
      setBusy(false);
      setRefreshing(false);
    }
  }, [display, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  const sign = CCY_SIGN[display];
  const instrumentPositions = useMemo(
    () => aggregateSummaryPositions(summary?.positions ?? [], summary?.kpi.positionsValue ?? 0, summary?.instruments),
    [summary],
  );
  const hasData = instrumentPositions.length > 0 || (summary?.cash.length ?? 0) > 0;
  const costs = summary?.costs ?? {
    bookCost: summary?.kpi.totalCost ?? null,
    externalNetInvested: null,
  };
  const pnl = summary?.pnl;
  const cashRatio = summary?.kpi.totalAssets ? summary.kpi.idleCash / summary.kpi.totalAssets : 0;
  const topSymbol = useMemo(() => {
    if (instrumentPositions.length === 0) return null;
    return [...instrumentPositions].sort((a, b) => b.holdingRatio - a.holdingRatio)[0];
  }, [instrumentPositions]);
  const topBucket = useMemo(() => {
    const total = summary?.kpi.positionsValue ?? 0;
    if (!summary || total <= 0 || summary.allocation.byBucket.length === 0) return null;
    const bucket = [...summary.allocation.byBucket].sort((a, b) => b.value - a.value)[0];
    return { ...bucket, ratio: bucket.value / total };
  }, [summary]);

  const pieTooltip = useMemo(() => ({
    ...LIGHT_TOOLTIP,
    formatter: (point: any) => `<b>${point.name}</b><br/>${sign}${fmtMoney(point.value)}<br/>占比：${point.percent}%`,
  }), [sign]);

  const donutOption = useMemo<EChartsOption>(() => {
    if (!summary) return {};
    return {
      tooltip: pieTooltip,
      legend: { bottom: 0, textStyle: { color: "#64748b", fontSize: 11 }, itemWidth: 10, itemHeight: 10 },
      series: [{
        type: "pie",
        radius: ["52%", "74%"],
        center: ["50%", "45%"],
        label: {
          show: true,
          position: "center",
          formatter: `{total|${sign}${fmtMoney(summary.kpi.totalAssets, 0)}}\n{unit|总净资产 (${display})}`,
          rich: {
            total: { fontSize: 20, fontWeight: 800, color: "#0f172a", lineHeight: 26 },
            unit: { fontSize: 10, color: "#94a3b8", lineHeight: 16 },
          },
        },
        labelLine: { show: false },
        itemStyle: { borderRadius: 5, borderColor: "#fff", borderWidth: 1.5 },
        data: [
          { ...summary.allocation.positionVsCash[0], itemStyle: { color: "#eab308" } },
          { ...summary.allocation.positionVsCash[1], itemStyle: { color: "#3b82f6" } },
        ],
      }],
    };
  }, [summary, pieTooltip, display, sign]);

  const sidePie = useCallback((data: Array<{ name: string; value: number }>, colors: Record<string, string> = {}): EChartsOption => ({
    tooltip: pieTooltip,
    legend: { orient: "vertical", right: 4, top: "middle", textStyle: { color: "#64748b", fontSize: 11 }, itemWidth: 10, itemHeight: 10 },
    series: [{
      type: "pie",
      radius: ["46%", "72%"],
      center: ["36%", "50%"],
      label: { show: false },
      itemStyle: { borderRadius: 4, borderColor: "#fff", borderWidth: 1.5 },
      data: data.map((item, index) => ({ ...item, itemStyle: { color: colors[item.name] ?? PALETTE[index % PALETTE.length] } })),
    }],
  }), [pieTooltip]);

  const symbolPieOption = useMemo(() => {
    if (!summary) return {};
    const top = summary.allocation.bySymbol.slice(0, 7);
    const rest = summary.allocation.bySymbol.slice(7).reduce((sum, item) => sum + item.value, 0);
    return sidePie(rest > 0 ? [...top, { name: "其他", value: rest }] : top);
  }, [summary, sidePie]);

  const bucketPieOption = useMemo(() => sidePie(summary?.allocation.byBucket ?? [], {
    进取仓: "#f97316", 防守仓: "#3b82f6", 稳健仓: "#22c55e", 授予仓: "#a855f7", 未分类: "#94a3b8",
  }), [summary, sidePie]);

  const historyOption = useMemo<EChartsOption>(() => {
    if (!summary) return {};
    return {
      tooltip: { ...LIGHT_TOOLTIP, trigger: "axis", valueFormatter: (value: unknown) => (typeof value === "number" ? `${sign}${fmtMoney(value, 0)}` : "—") },
      legend: { top: 0, textStyle: { color: "#64748b", fontSize: 11 } },
      grid: { left: 10, right: 10, top: 34, bottom: 8, containLabel: true },
      xAxis: { type: "category", data: summary.history.map((point) => point.month), axisLabel: { color: "#64748b", fontSize: 10 }, axisLine: { lineStyle: { color: "#e2e8f0" } }, axisTick: { show: false } },
      yAxis: { type: "value", axisLabel: { color: "#94a3b8", fontSize: 10, formatter: (value: number) => fmtCompact(value) }, splitLine: { lineStyle: { color: HAIRLINE } } },
      series: [
        {
          name: "盈亏",
          type: "bar",
          barWidth: 22,
          data: summary.history.map((point) => point.gainLossDisplay == null ? null : ({
            value: point.gainLossDisplay,
            itemStyle: {
              color: point.gainLossDisplay >= 0 ? GAIN : LOSS,
              borderRadius: point.gainLossDisplay >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4],
            },
          })),
        },
        { name: "账面成本", type: "line", data: summary.history.map((point) => point.costDisplay), lineStyle: { color: "#8b5cf6", width: 2, type: "dashed" }, itemStyle: { color: "#8b5cf6" } },
        { name: "市值", type: "line", data: summary.history.map((point) => point.valueDisplay), lineStyle: { color: "#eab308", width: 2 }, itemStyle: { color: "#eab308" } },
      ],
    };
  }, [summary]);

  if (busy) return <div className="empty"><span className="spin dark" /></div>;

  return (
    <div className="fade-in">
      <div className="page-heading-row">
        <div>
          <h1 className="page-title">资产总览</h1>
          <p className="page-desc">{summary?.asOf.length ? `数据基准：${summary.asOf.map((item) => `${item.broker} @ ${item.asOf}`).join(" · ")}` : "录入持仓与资本事件后开始盘点"}</p>
        </div>
        <div className="heading-actions">
          <div className="scope-toggle" role="tablist" aria-label="总览视图范围">
            <button role="tab" aria-selected={scope === "all"} className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>全部资产</button>
            <button role="tab" aria-selected={scope === "self"} className={scope === "self" ? "active" : ""} onClick={() => setScope("self")}>自主组合</button>
          </div>
          <label className="sr-only" htmlFor="dashboard-currency">展示币种</label>
          <select id="dashboard-currency" className="select currency-select" value={display} onChange={(event) => setDisplay(event.target.value as Currency)}><option value="USD">USD 计价</option><option value="HKD">HKD 计价</option><option value="CNY">CNY 计价</option></select>
          <button className="btn ghost btn-twin" disabled={refreshing || !hasData} onClick={() => load(true)}>
            <span className="twin" aria-hidden>刷新市值</span>
            <span className="face">{refreshing ? <span className="spin dark" /> : "刷新市值"}</span>
          </button>
        </div>
      </div>

      {error && <div className="alert error" role="alert">{error}</div>}
      {scope === "self" && (summary?.grant?.count ?? 0) > 0 && (
        <div className="alert warn" role="status">
          自主组合口径：已隔离授予仓（RSU）{summary?.grant?.symbols.join("、")} · {sign}{fmtMoney(summary?.grant?.valueDisplay ?? 0, 0)}，总资产/分布/盈亏均不含该部分；切回“全部资产”查看完整口径。
        </div>
      )}
      {summary?.coverage && summary.coverage.status !== "complete" && (
        <div className="alert warn coverage-alert">
          <div><b>部分数据</b>：未知成本或外部本金不会按 0 填充。</div>
          <div>{describeCoverageItems([...summary.coverage.issues, ...summary.coverage.missing]).join("；")}</div>
          <Link to="/data">补齐数据</Link>
        </div>
      )}
      {summary && summary.staleQuotes.length > 0 && <div className="alert warn">行情未更新：{summary.staleQuotes.join("、")}。安全计算会返回数据缺口。</div>}

      {!hasData ? (
        <div className="card empty"><div>还没有资产数据。</div><Link to="/data" className="btn empty-action">去数据管理</Link></div>
      ) : summary && (
        <>
          <section className="summary-primary-grid" aria-label="资产与成本核心指标">
            <div className="kpi"><div className="k">总净资产</div><div className="v"><ValueFlash value={summary.kpi.totalAssets}>{sign}{fmtMoney(summary.kpi.totalAssets, 0)}</ValueFlash><span className="unit">{display}</span></div></div>
            <div className="kpi ok"><div className="k">持仓市值</div><div className="v"><ValueFlash value={summary.kpi.positionsValue}>{sign}{fmtMoney(summary.kpi.positionsValue, 0)}</ValueFlash></div><div className="sub">{instrumentPositions.length} 个标的</div></div>
            <div className="kpi violet"><div className="k">账面成本</div><div className="v">{costs.bookCost == null ? "—" : `${sign}${fmtMoney(costs.bookCost, 0)}`}</div><div className="sub">当前剩余股份</div></div>
            <div className="kpi blue"><div className="k">外部净投入</div><div className="v">{costs.externalNetInvested == null ? "待初始化" : `${sign}${fmtMoney(costs.externalNetInvested, 0)}`}</div><div className="sub">仅外部资本事件</div></div>
            <div className="kpi accent"><div className="k">现金 / 安全线</div><div className="v">{sign}{fmtMoney(summary.kpi.idleCash, 0)}</div><div className={`sub ${cashRatio >= risk.cashFloor ? "pos" : "neg"}`}>{ratioText(cashRatio)} / 至少 {ratioText(risk.cashFloor)}</div></div>
          </section>

          <div className="grid grid-2 decision-grid">
            <section className="card" aria-labelledby="pnl-title">
              <div className="card-h" id="pnl-title">累计总盈亏<span className="tag">{summary.coverage?.status === "complete" ? "完整口径" : "已知部分"}</span></div>
              <div className="pnl-total"><span>解释盈亏</span><b className={(pnl?.explainedTotal ?? summary.kpi.gainLoss) >= 0 ? "pos" : "neg"}>{pnlText(sign, pnl?.explainedTotal ?? summary.kpi.gainLoss)}</b></div>
              <div className="pnl-breakdown">
                <div><span>已实现资本利得</span><b>{pnlText(sign, pnl?.realizedCapitalGain)}</b></div>
                <div><span>未实现资本利得</span><b>{pnlText(sign, pnl?.unrealizedCapitalGain)}</b></div>
                <div><span>净股息</span><b>{pnlText(sign, pnl?.dividendsNet)}</b></div>
                <div><span>交易费用</span><b className="neg">{pnl?.tradingFees == null ? "—" : `-${sign}${fmtMoney(Math.abs(pnl.tradingFees), 0)}`}</b></div>
                <div><span>融资费用</span><b className="neg">{pnl?.financingFees == null ? "—" : `-${sign}${fmtMoney(Math.abs(pnl.financingFees), 0)}`}</b></div>
              </div>
              <div className="reconcile-row"><span>经济盈亏（净资产 − 外部净投入）</span><b>{pnlText(sign, pnl?.economicTotal)}</b></div>
              <div className="reconcile-row"><span>未解释差额</span><b>{pnlText(sign, pnl?.unexplained)}</b></div>
            </section>

            <section className="card" aria-labelledby="risk-title">
              <div className="card-h" id="risk-title">资金安全边界<span className="tag">持仓内集中度</span></div>
              <div className="constraint-list">
                <div className="constraint-row"><div><span>现金率</span><b>{ratioText(cashRatio)}</b></div><progress max={1} value={Math.min(cashRatio / Math.max(risk.cashFloor, 0.001), 1)} /><small>下限 {ratioText(risk.cashFloor)}</small></div>
                <div className="constraint-row"><div><span>最高标的 · {topSymbol?.symbol ?? "—"}</span><b>{ratioText(topSymbol?.holdingRatio)}</b></div><progress max={1} value={Math.min((topSymbol?.holdingRatio ?? 0) / Math.max(risk.symbolLimit, 0.001), 1)} /><small>上限 {ratioText(risk.symbolLimit)}</small></div>
                <div className="constraint-row"><div><span>最高仓 · {topBucket?.name ?? "—"}</span><b>{ratioText(topBucket?.ratio)}</b></div><progress max={1} value={Math.min((topBucket?.ratio ?? 0) / Math.max(risk.bucketLimit, 0.001), 1)} /><small>上限 {ratioText(risk.bucketLimit)}</small></div>
              </div>
              <div className="budget-strip">{budgets.length === 0 ? <span>尚未设置本季度仓预算</span> : budgets.map((budget) => <div key={budget.bucket}><span>{BUCKET_LABELS[budget.bucket] ?? budget.bucket}</span><b>{budget.availableUsd == null ? "待设置" : `$${fmtMoney(budget.availableUsd, 0)} 可用`}</b></div>)}</div>
              <Link className="btn ghost full-width" to="/plans">计算指定标的安全金额</Link>
            </section>
          </div>

          <section className="grid grid-3 charts-secondary" aria-label="辅助分布图表">
            <div className="card"><div className="card-h">仓位与现金<span className="tag">辅助观察</span></div><Chart option={donutOption} height={250} /></div>
            <div className="card"><div className="card-h">标的分布<span className="tag">Top 7 + 其他</span></div><Chart option={symbolPieOption} height={250} /></div>
            <div className="card"><div className="card-h">三仓分布<span className="tag">辅助观察</span></div><Chart option={bucketPieOption} height={250} /></div>
          </section>

          <section className="card section-card"><div className="card-h">资产与账面成本历史<span className="tag">历史口径随数据覆盖变化</span></div>{summary.history.length ? <Chart option={historyOption} height={300} /> : <div className="empty">上传不同月份月结单后显示历史</div>}</section>
        </>
      )}
    </div>
  );
}
