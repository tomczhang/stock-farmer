import type { EChartsOption } from "echarts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import { Chart, fmtCompact, fmtMoney, gradientBarVertical, LIGHT_TOOLTIP } from "../components/Chart";
import type { Currency, ClosedStats, PerformanceResponse } from "../types";

const CCY_SIGN: Record<Currency, string> = { USD: "$", HKD: "HK$", CNY: "¥" };
/** 月度盈亏配色：盈利青绿 / 亏损暗红（导图口径）。 */
const GAIN_COLOR = "#14b8a6";
const LOSS_COLOR = "#b91c1c";

function pctText(value: number | null | undefined, digits = 2) {
  return value == null ? "—" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`;
}

export default function PerformancePage() {
  const [display, setDisplay] = useState<Currency>("USD");
  const [scope, setScope] = useState<"self" | "all">("self");
  const [data, setData] = useState<PerformanceResponse | null>(null);
  const [stats, setStats] = useState<ClosedStats | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const [nextData, nextStats] = await Promise.all([
        api.get<PerformanceResponse>(`/api/portfolio/performance?display=${display}&scope=${scope}`),
        api.get<ClosedStats>(`/api/trades/closed-stats?display=${display}`),
      ]);
      setData(nextData);
      setStats(nextStats);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "绩效数据加载失败");
    } finally {
      setBusy(false);
    }
  }, [display, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  const sign = CCY_SIGN[display];
  const months = data?.months ?? [];
  const kpi = data?.kpi;
  const hasSeries = months.some((m) => m.nav != null);
  const carriedMonths = months.filter((m) => m.carried);
  const warningMonths = months.filter((m) => m.warning);

  /** 净值曲线：左轴单位净值折线（carried 月份空心点），右轴回撤填充面积。 */
  const navOption = useMemo<EChartsOption>(() => {
    if (!months.length) return {};
    return {
      tooltip: {
        ...LIGHT_TOOLTIP,
        trigger: "axis",
        formatter: (params: any) => {
          const items = Array.isArray(params) ? params : [params];
          const month = items[0]?.axisValue ?? "";
          const point = months.find((m) => m.month === month);
          if (!point) return month;
          return [
            `<b>${month}</b>${point.carried ? "（缺月结转）" : ""}`,
            `单位净值：${point.nav?.toFixed(4) ?? "—"}`,
            `累计收益率：${pctText(point.cumulativeReturn)}`,
            `距高点回撤：${pctText(point.drawdown)}`,
            `净资产：${sign}${fmtMoney(point.netAssetsDisplay, 0)}`,
            point.warning ? `⚠️ ${point.warning}` : "",
          ].filter(Boolean).join("<br/>");
        },
      },
      legend: { top: 0, textStyle: { color: "#64748b", fontSize: 11 } },
      grid: { left: 10, right: 10, top: 34, bottom: 8, containLabel: true },
      xAxis: {
        type: "category",
        data: months.map((m) => m.month),
        axisLabel: { color: "#64748b", fontSize: 10 },
        axisLine: { lineStyle: { color: "#e2e8f0" } },
        axisTick: { show: false },
      },
      yAxis: [
        {
          type: "value",
          name: "单位净值",
          scale: true,
          axisLabel: { color: "#94a3b8", fontSize: 10, formatter: (v: number) => v.toFixed(2) },
          splitLine: { lineStyle: { color: "#f1f5f9" } },
        },
        {
          type: "value",
          name: "回撤",
          max: 0,
          axisLabel: { color: "#94a3b8", fontSize: 10, formatter: (v: number) => `${(v * 100).toFixed(0)}%` },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: "单位净值",
          type: "line",
          yAxisIndex: 0,
          data: months.map((m) => m.nav),
          lineStyle: { color: "#0ea5e9", width: 2 },
          itemStyle: { color: "#0ea5e9" },
          // 缺月结转的点用空心样式提示口径
          symbol: (_: unknown, params: any) => (months[params.dataIndex]?.carried ? "emptyCircle" : "circle"),
          symbolSize: (_: unknown, params: any) => (months[params.dataIndex]?.carried ? 7 : 4),
          connectNulls: true,
        },
        {
          name: "距高点回撤",
          type: "line",
          yAxisIndex: 1,
          data: months.map((m) => m.drawdown),
          lineStyle: { color: "#f43f5e", width: 1 },
          itemStyle: { color: "#f43f5e" },
          symbol: "none",
          areaStyle: { color: "rgba(244, 63, 94, 0.12)" },
          connectNulls: true,
        },
      ],
    };
  }, [months, sign]);

  /** 月度盈亏柱状图：盈利青绿/亏损暗红 + 全期平均虚线；右轴叠月度累计收益率折线。 */
  const pnlOption = useMemo<EChartsOption>(() => {
    if (!months.length) return {};
    const avg = kpi?.avgMonthlyPnlDisplay ?? null;
    return {
      tooltip: {
        ...LIGHT_TOOLTIP,
        trigger: "axis",
        formatter: (params: any) => {
          const items = Array.isArray(params) ? params : [params];
          const month = items[0]?.axisValue ?? "";
          const point = months.find((m) => m.month === month);
          if (!point) return month;
          return [
            `<b>${month}</b>`,
            `当月投资盈亏：${point.pnlDisplay == null ? "—" : `${point.pnlDisplay >= 0 ? "+" : "-"}${sign}${fmtMoney(Math.abs(point.pnlDisplay), 0)}`}`,
            `当月出入金：${point.flowDisplay >= 0 ? "+" : "-"}${sign}${fmtMoney(Math.abs(point.flowDisplay), 0)}`,
            `累计收益率：${pctText(point.cumulativeReturn)}`,
          ].join("<br/>");
        },
      },
      legend: { top: 0, textStyle: { color: "#64748b", fontSize: 11 } },
      grid: { left: 10, right: 10, top: 34, bottom: 8, containLabel: true },
      xAxis: {
        type: "category",
        data: months.map((m) => m.month),
        axisLabel: { color: "#64748b", fontSize: 10 },
        axisLine: { lineStyle: { color: "#e2e8f0" } },
        axisTick: { show: false },
      },
      yAxis: [
        {
          type: "value",
          name: "月度盈亏",
          axisLabel: { color: "#94a3b8", fontSize: 10, formatter: (v: number) => fmtCompact(v) },
          splitLine: { lineStyle: { color: "#f1f5f9" } },
        },
        {
          type: "value",
          name: "累计收益率",
          axisLabel: { color: "#94a3b8", fontSize: 10, formatter: (v: number) => `${(v * 100).toFixed(0)}%` },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: "月度盈亏",
          type: "bar",
          barWidth: 20,
          yAxisIndex: 0,
          data: months.map((m) =>
            m.pnlDisplay == null
              ? null
              : {
                  value: m.pnlDisplay,
                  itemStyle: {
                    color: gradientBarVertical(m.pnlDisplay >= 0 ? GAIN_COLOR : LOSS_COLOR),
                    borderRadius: m.pnlDisplay >= 0 ? [6, 6, 0, 0] : [0, 0, 6, 6],
                  },
                },
          ),
          ...(avg != null
            ? {
                markLine: {
                  silent: true,
                  symbol: "none",
                  lineStyle: { color: "#64748b", type: "dashed", width: 1 },
                  label: { formatter: `平均 ${sign}${fmtMoney(avg, 0)}`, color: "#64748b", fontSize: 10, position: "insideEndTop" },
                  data: [{ yAxis: avg }],
                },
              }
            : {}),
        },
        {
          name: "累计收益率",
          type: "line",
          yAxisIndex: 1,
          data: months.map((m) => m.cumulativeReturn),
          lineStyle: { color: "#8b5cf6", width: 2 },
          itemStyle: { color: "#8b5cf6" },
          symbolSize: 4,
          connectNulls: true,
        },
      ],
    };
  }, [months, kpi, sign]);

  /** 单笔盈亏分布直方图：仅已平仓订单，浮盈不计入。 */
  const histogramOption = useMemo<EChartsOption>(() => {
    if (!stats || stats.closedCount === 0) return {};
    const labels = stats.histogram.buckets.map((b) => {
      if (b.from == null) return `< ${fmtCompact(b.to ?? 0)}`;
      if (b.to == null) return `> ${fmtCompact(b.from)}`;
      return `${fmtCompact(b.from)}~${fmtCompact(b.to)}`;
    });
    return {
      tooltip: { ...LIGHT_TOOLTIP, formatter: (p: any) => `盈亏区间 ${p.name}<br/>笔数：${p.value}` },
      grid: { left: 10, right: 10, top: 16, bottom: 8, containLabel: true },
      xAxis: { type: "category", data: labels, axisLabel: { color: "#64748b", fontSize: 9, interval: 0, rotate: 30 }, axisLine: { lineStyle: { color: "#e2e8f0" } }, axisTick: { show: false } },
      yAxis: { type: "value", minInterval: 1, axisLabel: { color: "#94a3b8", fontSize: 10 }, splitLine: { lineStyle: { color: "#f1f5f9" } } },
      series: [{
        type: "bar",
        barWidth: 16,
        data: stats.histogram.buckets.map((b, i) => ({
          value: b.count,
          itemStyle: { color: gradientBarVertical(i < stats.histogram.buckets.length / 2 - 0.5 ? LOSS_COLOR : GAIN_COLOR), borderRadius: [4, 4, 0, 0] },
        })),
      }],
    };
  }, [stats]);

  if (busy) return <div className="empty"><span className="spin dark" /></div>;

  return (
    <div className="fade-in">
      <div className="page-heading-row">
        <div>
          <h1 className="page-title">绩效</h1>
          <p className="page-desc">单位净值剔除出入金干扰：入金只增份额、不改净值，衡量真实投资水平</p>
        </div>
        <div className="heading-actions">
          <div className="scope-toggle" role="tablist" aria-label="绩效视图范围">
            <button role="tab" aria-selected={scope === "self"} className={scope === "self" ? "active" : ""} onClick={() => setScope("self")}>自主组合</button>
            <button role="tab" aria-selected={scope === "all"} className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>全部资产</button>
          </div>
          <label className="sr-only" htmlFor="performance-currency">展示币种</label>
          <select id="performance-currency" className="select currency-select" value={display} onChange={(event) => setDisplay(event.target.value as Currency)}>
            <option value="USD">USD 计价</option>
            <option value="HKD">HKD 计价</option>
            <option value="CNY">CNY 计价</option>
          </select>
        </div>
      </div>

      {error && <div className="alert error" role="alert">{error}</div>}
      {carriedMonths.length > 0 && (
        <div className="alert warn" role="status">
          {carriedMonths.map((m) => `${m.month}（${m.carriedBrokers.join("、")}）`).join("、")} 缺当月月结单，已沿用上期快照（曲线空心点）；补传后自动修正。
        </div>
      )}
      {warningMonths.length > 0 && (
        <div className="alert warn" role="status">
          {warningMonths.map((m) => m.month).join("、")} 出入金超过上月净资产 20%，当月净值受大额出入金影响，解读时注意。
        </div>
      )}

      {!hasSeries ? (
        <div className="card empty">
          <div>还没有可计算净值的月度数据（至少需要一份月结单）。</div>
          <Link to="/data" className="btn empty-action">去数据管理</Link>
        </div>
      ) : (
        <>
          <section className="summary-primary-grid" aria-label="绩效核心指标">
            <div className="kpi">
              <div className="k">累计收益率</div>
              <div className={`v ${(kpi?.cumulativeReturn ?? 0) >= 0 ? "" : "neg"}`}>{pctText(kpi?.cumulativeReturn)}</div>
              <div className="sub">{kpi?.monthCount ?? 0} 个月净值样本</div>
            </div>
            <div className="kpi ok">
              <div className="k">年化收益率</div>
              <div className="v">{pctText(kpi?.annualizedReturn)}</div>
              <div className="sub">{kpi?.annualizedPartial ? "未满一年，仅供参考" : "复利月度折算"}</div>
            </div>
            <div className="kpi violet">
              <div className="k">最大回撤</div>
              <div className="v">{pctText(kpi?.maxDrawdown)}</div>
              <div className="sub">基于单位净值序列</div>
            </div>
            <div className="kpi blue">
              <div className="k">累计入金</div>
              <div className="v">{sign}{fmtMoney(kpi?.cumulativeInDisplay ?? 0, 0)}</div>
              <div className="sub">累计出金 {sign}{fmtMoney(kpi?.cumulativeOutDisplay ?? 0, 0)}</div>
            </div>
            <div className="kpi accent">
              <div className="k">当月盈亏</div>
              <div className={`v ${(kpi?.latestMonthPnlDisplay ?? 0) >= 0 ? "" : "neg"}`}>
                {kpi?.latestMonthPnlDisplay == null ? "—" : `${kpi.latestMonthPnlDisplay >= 0 ? "+" : "-"}${sign}${fmtMoney(Math.abs(kpi.latestMonthPnlDisplay), 0)}`}
              </div>
              <div className="sub">月末净资产 − 月初 − 净入金</div>
            </div>
          </section>

          <section className="card section-card">
            <div className="card-h">净值曲线<span className="tag">左轴净值 · 右轴回撤</span></div>
            <Chart option={navOption} height={320} />
          </section>

          <section className="card section-card">
            <div className="card-h">月度盈亏<span className="tag">盈利青绿 · 亏损暗红 · 虚线为全期均值</span></div>
            <Chart option={pnlOption} height={300} />
          </section>

          <section className="card section-card">
            <div className="card-h">已平仓交易统计<span className="tag">仅统计已平仓订单 · 浮盈不计入</span></div>
            {!stats || stats.closedCount === 0 ? (
              <div className="empty">还没有已平仓交易{(stats?.unknownCount ?? 0) > 0 ? `（另有 ${stats?.unknownCount} 笔卖出缺已实现盈亏数据）` : ""}</div>
            ) : (
              <div className="grid grid-2">
                <Chart option={histogramOption} height={260} />
                <div className="pnl-breakdown" style={{ alignContent: "start" }}>
                  <div><span>总平仓笔数</span><b>{stats.closedCount}{stats.unknownCount > 0 ? `（另 ${stats.unknownCount} 笔缺盈亏数据）` : ""}</b></div>
                  <div><span>盈利 / 亏损单数</span><b>{stats.winCount} / {stats.lossCount}</b></div>
                  <div><span>胜率</span><b>{pctText(stats.winRate)}</b></div>
                  <div><span>平均单笔盈利 / 亏损</span><b>{stats.avgWinDisplay == null ? "—" : `+${sign}${fmtMoney(stats.avgWinDisplay, 0)}`} / {stats.avgLossDisplay == null ? "—" : `-${sign}${fmtMoney(Math.abs(stats.avgLossDisplay), 0)}`}</b></div>
                  <div><span>盈亏比</span><b>{stats.payoffRatio == null ? "—" : stats.payoffRatio.toFixed(2)}</b></div>
                  <div><span>最大单笔盈利 / 亏损</span><b>{stats.maxWinDisplay == null ? "—" : `+${sign}${fmtMoney(stats.maxWinDisplay, 0)}`} / {stats.maxLossDisplay == null ? "—" : `-${sign}${fmtMoney(Math.abs(stats.maxLossDisplay), 0)}`}</b></div>
                  <div><span>平均持仓时长（近似）</span><b>{stats.avgHoldingDays == null ? "—" : `${stats.avgHoldingDays} 天`}</b></div>
                  <div><span>累计手续费</span><b>{sign}{fmtMoney(stats.totalFeesDisplay, 0)}{stats.feeRatio == null ? "" : `（占已实现盈亏 ${(stats.feeRatio * 100).toFixed(1)}%）`}</b></div>
                </div>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
