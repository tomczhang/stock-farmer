import type { EChartsOption } from "echarts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import { Chart, fmtCompact, fmtMoney, GAIN, HAIRLINE, LIGHT_TOOLTIP, LOSS, PALETTE } from "../components/Chart";
import { ValueFlash } from "../components/ValueFlash";
import { describeCoverageItems } from "../lib/portfolio/coverage";
import { aggregateSummaryPositions } from "../lib/portfolio/positions";
import { useGraceSpinner } from "../lib/useGraceSpinner";
import {
  BUCKET_LABELS,
  type BucketBudget,
  type Currency,
  type PerformanceResponse,
  type RiskSettings,
  type Summary,
} from "../types";

const CCY_SIGN: Record<Currency, string> = { USD: "$", HKD: "HK$", CNY: "¥" };
const INK = "#0f172a";
/** 三仓分布配色（沿用原饼图口径） */
const BUCKET_COLORS: Record<string, string> = {
  进取仓: "#f97316", 防守仓: "#3b82f6", 稳健仓: "#22c55e", 授予仓: "#a855f7", 未分类: "#94a3b8",
};
type RangeKey = "6m" | "1y" | "all";
const RANGE_LABELS: Array<{ key: RangeKey; label: string; months: number | null }> = [
  { key: "6m", label: "6月", months: 6 },
  { key: "1y", label: "1年", months: 12 },
  { key: "all", label: "全部", months: null },
];

function ratioText(value: number | null | undefined) {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function pnlText(sign: string, value: number | null | undefined) {
  if (value == null) return "—";
  return `${value >= 0 ? "+" : "-"}${sign}${fmtMoney(Math.abs(value), 0)}`;
}

/** 占总资产百分比列（两位小数，带符号） */
function pctOfText(value: number | null | undefined, base: number) {
  if (value == null || !(base > 0)) return "—";
  const pct = (value / base) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

type Status = "充足" | "正常" | "超限" | "待设置";
const STATUS_COLOR: Record<Status, string> = { 充足: "var(--gain)", 正常: "var(--brand)", 超限: "var(--loss)", 待设置: "var(--ink-4)" };

function StatusCell({ status }: { status: Status }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", fontWeight: 600, fontSize: 12 }}>
      <span className="status-dot" style={{ background: STATUS_COLOR[status] }} />
      {status}
    </span>
  );
}

/** 下限类约束（越高越好）：高出下限 5pp 为充足 */
function floorStatus(current: number | null, floor: number): Status {
  if (current == null) return "待设置";
  if (current >= floor + 0.05) return "充足";
  if (current >= floor) return "正常";
  return "超限";
}

/** 上限类约束（越低越好）：低于上限 5pp 为充足 */
function ceilStatus(current: number | null, ceil: number): Status {
  if (current == null) return "待设置";
  if (current <= ceil - 0.05) return "充足";
  if (current <= ceil) return "正常";
  return "超限";
}

function currentQuarter() {
  const now = new Date();
  return `${now.getFullYear()}-Q${Math.floor(now.getMonth() / 3) + 1}`;
}

export default function DashboardPage() {
  const [display, setDisplay] = useState<Currency>("USD");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [perf, setPerf] = useState<PerformanceResponse | null>(null);
  const [risk, setRisk] = useState<RiskSettings>({ symbolLimit: 0.5, bucketLimit: 0.5, cashFloor: 0.3 });
  const [budgets, setBudgets] = useState<BucketBudget[]>([]);
  const [busy, setBusy] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  // 分层视图：总览默认看全部资产（含授予仓），可切到自主组合
  const [scope, setScope] = useState<"all" | "self">("all");
  const [range, setRange] = useState<RangeKey>("all");
  const [distTab, setDistTab] = useState<"symbol" | "bucket">("symbol");

  const load = useCallback(async (refresh = false) => {
    refresh ? setRefreshing(true) : setBusy(true);
    setError("");
    try {
      const [nextSummary, nextPerf, nextRisk, nextBudgets] = await Promise.all([
        api.get<Summary>(`/api/portfolio/summary?display=${display}${scope === "self" ? "&scope=self" : ""}${refresh ? "&refresh=1" : ""}`),
        api.get<PerformanceResponse>(`/api/portfolio/performance?display=${display}&scope=${scope}`),
        api.get<RiskSettings>("/api/risk-settings"),
        api.get<{ quarter: string; budgets: BucketBudget[] }>(`/api/bucket-budgets?quarter=${currentQuarter()}`),
      ]);
      setSummary(nextSummary);
      setPerf(nextPerf);
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
  const totalAssets = summary?.kpi.totalAssets ?? 0;
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
  // 累计总盈亏（经济盈亏口径 = 净资产 − 外部净投入），占净投入比例
  const totalPnl = pnl?.economicTotal ?? pnl?.explainedTotal ?? null;
  const totalPnlRatio =
    totalPnl != null && costs.externalNetInvested != null && costs.externalNetInvested > 0
      ? totalPnl / costs.externalNetInvested
      : null;
  // 数据截至：最新快照日期 + 各券商明细
  const latestAsOf = summary?.asOf.length ? [...summary.asOf.map((item) => item.asOf)].sort().at(-1) : null;

  /** Hero 双线图：总净资产（墨色实线带月点）vs 累计外部净投入（灰色虚线）——两线间距即累计盈亏 */
  const heroMonths = useMemo(() => {
    const months = perf?.months ?? [];
    const limit = RANGE_LABELS.find((r) => r.key === range)?.months ?? null;
    return limit == null ? months : months.slice(-limit);
  }, [perf, range]);

  const heroOption = useMemo<EChartsOption>(() => {
    if (!heroMonths.length) return {};
    return {
      tooltip: {
        ...LIGHT_TOOLTIP,
        trigger: "axis",
        formatter: (params: any) => {
          const items = Array.isArray(params) ? params : [params];
          const month = items[0]?.axisValue ?? "";
          const point = heroMonths.find((m) => m.month === month);
          if (!point) return month;
          const gap = point.netAssetsDisplay - point.investedDisplay;
          return [
            `<b>${month}</b>${point.carried ? "（缺月结转）" : ""}`,
            `总净资产：${sign}${fmtMoney(point.netAssetsDisplay, 0)}`,
            `外部净投入：${sign}${fmtMoney(point.investedDisplay, 0)}`,
            `累计盈亏（两线间距）：<b style="color:${gap >= 0 ? GAIN : LOSS}">${gap >= 0 ? "+" : "-"}${sign}${fmtMoney(Math.abs(gap), 0)}</b>`,
          ].join("<br/>");
        },
      },
      legend: { top: 0, textStyle: { color: "#64748b", fontSize: 11 } },
      grid: { left: 10, right: 14, top: 34, bottom: 8, containLabel: true },
      xAxis: {
        type: "category",
        data: heroMonths.map((m) => m.month),
        axisLabel: { color: "#64748b", fontSize: 10 },
        axisLine: { lineStyle: { color: "#e2e8f0" } },
        axisTick: { show: false },
      },
      yAxis: {
        type: "value",
        scale: true,
        axisLabel: { color: "#94a3b8", fontSize: 10, formatter: (v: number) => fmtCompact(v) },
        splitLine: { lineStyle: { color: HAIRLINE } },
      },
      series: [
        {
          name: "总净资产",
          type: "line",
          data: heroMonths.map((m) => m.netAssetsDisplay),
          lineStyle: { color: INK, width: 2 },
          itemStyle: { color: INK },
          symbol: (_: unknown, params: any) => (heroMonths[params.dataIndex]?.carried ? "emptyCircle" : "circle"),
          symbolSize: (_: unknown, params: any) => (heroMonths[params.dataIndex]?.carried ? 7 : 4),
        },
        {
          name: "外部净投入",
          type: "line",
          data: heroMonths.map((m) => m.investedDisplay),
          lineStyle: { color: "#94a3b8", width: 1.5, type: "dashed" },
          itemStyle: { color: "#94a3b8" },
          symbol: "none",
        },
      ],
    };
  }, [heroMonths, sign]);

  /** 持仓分布：按标的 Top5+其他 / 按三仓 */
  const distRows = useMemo(() => {
    const positionsValue = summary?.kpi.positionsValue ?? 0;
    if (positionsValue <= 0) return [];
    if (distTab === "symbol") {
      const sorted = [...instrumentPositions].sort((a, b) => b.valueDisplay - a.valueDisplay);
      const top = sorted.slice(0, 5).map((p, i) => ({
        key: p.symbol,
        label: p.symbol,
        sub: p.name !== p.symbol ? p.name : "",
        value: p.valueDisplay,
        ratio: p.valueDisplay / positionsValue,
        color: PALETTE[i % PALETTE.length],
      }));
      const rest = sorted.slice(5).reduce((sum, p) => sum + p.valueDisplay, 0);
      return rest > 0
        ? [...top, { key: "__rest", label: "其他", sub: `${sorted.length - 5} 个标的`, value: rest, ratio: rest / positionsValue, color: "#cbd5e1" }]
        : top;
    }
    return (summary?.allocation.byBucket ?? []).map((item) => ({
      key: item.name,
      label: item.name,
      sub: "",
      value: item.value,
      ratio: item.value / positionsValue,
      color: BUCKET_COLORS[item.name] ?? "#94a3b8",
    }));
  }, [summary, instrumentPositions, distTab]);

  // 首载才整页等待（220ms 宽限）；切 scope/币种不清空旧内容
  const firstLoading = busy && !summary;
  const showSpinner = useGraceSpinner(firstLoading);
  if (firstLoading) return showSpinner ? <div className="empty"><span className="spin dark" /></div> : null;

  return (
    <div className="fade-in">
      <div className="page-heading-row">
        <div>
          <h1 className="page-title">资产总览</h1>
          <p className="page-desc">
            {latestAsOf
              ? <>数据截至 <b>{latestAsOf}</b><span style={{ color: "var(--ink-4)" }}> · {summary?.asOf.map((item) => `${item.broker} @ ${item.asOf}`).join(" · ")}</span></>
              : "录入持仓与资本事件后开始盘点"}
          </p>
        </div>
        <div className="heading-actions">
          {/* 页面专属按钮在左，共享控件（切换器+币种）贴右与其他页对齐，切页不横跳 */}
          <button className="btn ghost btn-twin" disabled={refreshing || !hasData} onClick={() => load(true)}>
            <span className="twin" aria-hidden>刷新市值</span>
            <span className="face">{refreshing ? <span className="spin dark" /> : "刷新市值"}</span>
          </button>
          <div className="scope-toggle" role="tablist" aria-label="总览视图范围">
            <button role="tab" aria-selected={scope === "self"} className={scope === "self" ? "active" : ""} onClick={() => setScope("self")}>自主组合</button>
            <button role="tab" aria-selected={scope === "all"} className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>全部资产</button>
          </div>
          <label className="sr-only" htmlFor="dashboard-currency">展示币种</label>
          <select id="dashboard-currency" className="select currency-select" value={display} onChange={(event) => setDisplay(event.target.value as Currency)}><option value="USD">USD 计价</option><option value="HKD">HKD 计价</option><option value="CNY">CNY 计价</option></select>
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
          <div className="hero-grid">
            {/* Hero：资产走势（浅色 B 案）——两线间距即累计盈亏 */}
            <section className="card hero-card" aria-label="资产走势">
              <div className="hero-head">
                <div className="hero-nums">
                  <div className="hero-num main">
                    <div className="k">总净资产（{display}）</div>
                    <div className="v"><ValueFlash value={summary.kpi.totalAssets}>{sign}{fmtMoney(summary.kpi.totalAssets, 0)}</ValueFlash></div>
                  </div>
                  <div className="hero-num">
                    <div className="k">累计总盈亏 <span title="经济盈亏 = 净资产 − 外部净投入；月度快照口径" style={{ cursor: "help", color: "var(--ink-4)" }}>ⓘ</span></div>
                    <div className={`v ${totalPnl != null && totalPnl < 0 ? "neg" : "pos"}`} style={{ fontSize: 20 }}>
                      {pnlText(sign, totalPnl)}{totalPnlRatio != null && <span style={{ fontSize: 13, marginLeft: 6 }}>· {totalPnlRatio >= 0 ? "+" : ""}{(totalPnlRatio * 100).toFixed(2)}%</span>}
                    </div>
                  </div>
                </div>
                <div className="scope-toggle" role="tablist" aria-label="走势时间范围">
                  {RANGE_LABELS.map((r) => (
                    <button key={r.key} role="tab" aria-selected={range === r.key} className={range === r.key ? "active" : ""} onClick={() => setRange(r.key)}>{r.label}</button>
                  ))}
                </div>
              </div>
              {heroMonths.length >= 2 ? (
                <Chart option={heroOption} height={280} />
              ) : (
                <div className="empty" style={{ height: 280 }}>
                  {heroMonths.length === 1
                    ? `暂只有 ${heroMonths[0].month} 一期快照，补传历史月结单后即可成线`
                    : "上传月结单后显示资产走势"}
                </div>
              )}
              <div className="hero-metrics">
                <div><span>持仓市值</span><b>{sign}{fmtMoney(summary.kpi.positionsValue, 0)}</b><small className={summary.kpi.gainLossRatio == null ? "" : summary.kpi.gainLossRatio >= 0 ? "pos" : "neg"}>{summary.kpi.gainLossRatio == null ? "" : `${summary.kpi.gainLossRatio >= 0 ? "+" : ""}${(summary.kpi.gainLossRatio * 100).toFixed(2)}%`}</small></div>
                <div><span>账面成本</span><b>{costs.bookCost == null ? "—" : `${sign}${fmtMoney(costs.bookCost, 0)}`}</b></div>
                <div><span>外部净投入</span><b>{costs.externalNetInvested == null ? "待初始化" : `${sign}${fmtMoney(costs.externalNetInvested, 0)}`}</b></div>
                <div><span>现金</span><b>{sign}{fmtMoney(summary.kpi.idleCash, 0)}</b><small className={cashRatio >= risk.cashFloor ? "pos" : "neg"}>{ratioText(cashRatio)}</small></div>
              </div>
            </section>

            {/* 持仓分布：堆叠条 + Top5 表 + 关键约束 */}
            <section className="card dist-card" aria-label="持仓分布">
              <div className="card-h">持仓分布
                <span className="scope-toggle" role="tablist" aria-label="分布口径" style={{ marginLeft: "auto" }}>
                  <button role="tab" aria-selected={distTab === "symbol"} className={distTab === "symbol" ? "active" : ""} onClick={() => setDistTab("symbol")}>按标的</button>
                  <button role="tab" aria-selected={distTab === "bucket"} className={distTab === "bucket" ? "active" : ""} onClick={() => setDistTab("bucket")}>按三仓</button>
                </span>
              </div>
              <div className="stack-bar" aria-hidden>
                {distRows.map((row) => (
                  <i key={row.key} style={{ width: `${Math.max(row.ratio * 100, 1)}%`, background: row.color }} title={`${row.label} ${ratioText(row.ratio)}`}>
                    {row.ratio >= 0.08 ? ratioText(row.ratio) : ""}
                  </i>
                ))}
              </div>
              <table className="table rank-table">
                <thead><tr><th>#</th><th>{distTab === "symbol" ? "标的 / 名称" : "仓别"}</th><th className="num">市值（{display}）</th><th className="num">占比</th></tr></thead>
                <tbody>
                  {distRows.map((row, index) => (
                    <tr key={row.key}>
                      <td style={{ color: "var(--ink-4)" }}>{index + 1}</td>
                      <td><span className="dist-swatch" style={{ background: row.color }} /><b>{row.label}</b>{row.sub && <span className="cell-sub">{row.sub}</span>}</td>
                      <td className="num">{fmtMoney(row.value, 0)}</td>
                      <td className="num">{ratioText(row.ratio)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="dist-constraints">
                <div><span>现金率</span><b><StatusCell status={floorStatus(cashRatio, risk.cashFloor)} /> {ratioText(cashRatio)} / 下限 {ratioText(risk.cashFloor)}</b></div>
                <div><span>最高标的 · {topSymbol?.symbol ?? "—"}</span><b><StatusCell status={ceilStatus(topSymbol?.holdingRatio ?? null, risk.symbolLimit)} /> {ratioText(topSymbol?.holdingRatio)} / 上限 {ratioText(risk.symbolLimit)}</b></div>
                <div><span>标的数量</span><b>{instrumentPositions.length}</b></div>
              </div>
              <Link className="dist-more" to="/holdings">查看全部持仓 →</Link>
            </section>
          </div>

          <div className="grid grid-2 decision-grid">
            {/* 盈亏拆解：金额 + 占总资产% + 合计行 */}
            <section className="card" aria-labelledby="pnl-title">
              <div className="card-h" id="pnl-title">盈亏拆解<span className="tag">{summary.coverage?.status === "complete" ? "完整口径" : "已知部分"}</span></div>
              <table className="table pnl-table">
                <thead><tr><th>项目</th><th className="num">金额（{display}）</th><th className="num">占总资产</th></tr></thead>
                <tbody>
                  <tr><td>已实现资本利得</td><td className={`num ${(pnl?.realizedCapitalGain ?? 0) >= 0 ? "pos" : "neg"}`}>{pnlText(sign, pnl?.realizedCapitalGain)}</td><td className="num">{pctOfText(pnl?.realizedCapitalGain, totalAssets)}</td></tr>
                  <tr><td>未实现资本利得</td><td className={`num ${(pnl?.unrealizedCapitalGain ?? 0) >= 0 ? "pos" : "neg"}`}>{pnlText(sign, pnl?.unrealizedCapitalGain)}</td><td className="num">{pctOfText(pnl?.unrealizedCapitalGain, totalAssets)}</td></tr>
                  <tr><td>净股息</td><td className="num pos">{pnlText(sign, pnl?.dividendsNet)}</td><td className="num">{pctOfText(pnl?.dividendsNet, totalAssets)}</td></tr>
                  <tr><td>交易费用</td><td className="num neg">{pnl?.tradingFees == null ? "—" : `-${sign}${fmtMoney(Math.abs(pnl.tradingFees), 0)}`}</td><td className="num">{pnl?.tradingFees == null ? "—" : pctOfText(-Math.abs(pnl.tradingFees), totalAssets)}</td></tr>
                  <tr><td>融资费用</td><td className="num neg">{pnl?.financingFees == null ? "—" : `-${sign}${fmtMoney(Math.abs(pnl.financingFees), 0)}`}</td><td className="num">{pnl?.financingFees == null ? "—" : pctOfText(-Math.abs(pnl.financingFees), totalAssets)}</td></tr>
                  <tr><td>经济盈亏（净资产 − 外部净投入）</td><td className={`num ${(pnl?.economicTotal ?? 0) >= 0 ? "pos" : "neg"}`}>{pnlText(sign, pnl?.economicTotal)}</td><td className="num">{pctOfText(pnl?.economicTotal, totalAssets)}</td></tr>
                  <tr><td>未解释差额</td><td className="num">{pnlText(sign, pnl?.unexplained)}</td><td className="num">{pctOfText(pnl?.unexplained, totalAssets)}</td></tr>
                </tbody>
                <tfoot>
                  <tr className="pnl-total-row"><td>累计总盈亏</td><td className={`num ${(totalPnl ?? 0) >= 0 ? "pos" : "neg"}`}><b>{pnlText(sign, totalPnl)}</b></td><td className="num"><b>{pctOfText(totalPnl, totalAssets)}</b></td></tr>
                </tfoot>
              </table>
            </section>

            {/* 资金安全边界：约束表 + 分仓预算表 */}
            <section className="card" aria-labelledby="risk-title">
              <div className="card-h" id="risk-title">资金安全边界<span className="tag">当前值 vs 阈值</span></div>
              <table className="table">
                <thead><tr><th>约束项</th><th className="num">当前值</th><th className="num">阈值 / 规则</th><th>状态</th></tr></thead>
                <tbody>
                  <tr><td>现金率（现金 / 总资产）</td><td className="num">{ratioText(cashRatio)}</td><td className="num">下限 {ratioText(risk.cashFloor)}</td><td><StatusCell status={floorStatus(cashRatio, risk.cashFloor)} /></td></tr>
                  <tr><td>最高标的集中度 · {topSymbol?.symbol ?? "—"}</td><td className="num">{ratioText(topSymbol?.holdingRatio)}</td><td className="num">上限 {ratioText(risk.symbolLimit)}</td><td><StatusCell status={ceilStatus(topSymbol?.holdingRatio ?? null, risk.symbolLimit)} /></td></tr>
                  <tr><td>最高仓集中度 · {topBucket?.name ?? "—"}</td><td className="num">{ratioText(topBucket?.ratio)}</td><td className="num">上限 {ratioText(risk.bucketLimit)}</td><td><StatusCell status={ceilStatus(topBucket?.ratio ?? null, risk.bucketLimit)} /></td></tr>
                </tbody>
              </table>
              <div className="card-h" style={{ marginTop: 14 }}>分仓预算使用<span className="tag">{currentQuarter()}</span></div>
              <table className="table">
                <thead><tr><th>仓别</th><th className="num">预算（USD）</th><th className="num">已用</th><th className="num">剩余</th><th>状态</th></tr></thead>
                <tbody>
                  {(["aggressive", "defensive", "stable"] as const).map((bucket) => {
                    const item = budgets.find((budget) => budget.bucket === bucket);
                    const status: Status = item?.availableUsd == null || item.limitUsd == null
                      ? "待设置"
                      : item.availableUsd / item.limitUsd > 0.2 ? "充足" : item.availableUsd > 0 ? "正常" : "超限";
                    return (
                      <tr key={bucket}>
                        <td>{BUCKET_LABELS[bucket]}</td>
                        <td className="num">{item?.limitUsd == null ? "—" : fmtMoney(item.limitUsd, 0)}</td>
                        <td className="num">{item ? fmtMoney(item.usedUsd, 0) : "—"}</td>
                        <td className="num">{item?.availableUsd == null ? "—" : fmtMoney(item.availableUsd, 0)}</td>
                        <td><StatusCell status={status} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <Link className="btn ghost full-width" to="/plans">计算指定标的安全金额</Link>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
