import type { EChartsOption } from "echarts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import { Chart, fmtMoney, gradientBarVertical, LIGHT_TOOLTIP, PALETTE } from "../components/Chart";
import type { Currency, Summary } from "../types";

const CCY_SIGN: Record<Currency, string> = { USD: "$", HKD: "HK$", CNY: "¥" };

export default function DashboardPage() {
  const [display, setDisplay] = useState<Currency>("USD");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [cashForm, setCashForm] = useState({ broker: "", currency: "USD" as Currency, amount: "" });
  const [cashSaving, setCashSaving] = useState(false);

  const load = useCallback(
    async (refresh = false) => {
      refresh ? setRefreshing(true) : setBusy(true);
      setError("");
      try {
        setSummary(
          await api.get<Summary>(`/api/portfolio/summary?display=${display}${refresh ? "&refresh=1" : ""}`),
        );
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "加载失败");
      } finally {
        setBusy(false);
        setRefreshing(false);
      }
    },
    [display],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const sign = CCY_SIGN[display];
  const hasData = (summary?.positions.length ?? 0) > 0 || (summary?.cash.length ?? 0) > 0;

  const pieTooltip = useMemo(
    () => ({
      ...LIGHT_TOOLTIP,
      formatter: (p: any) => `<b>${p.name}</b><br/>${sign}${fmtMoney(p.value)}<br/>占比：${p.percent}%`,
    }),
    [sign],
  );

  const donutOption = useMemo<EChartsOption>(() => {
    if (!summary) return {};
    const total = summary.kpi.totalAssets;
    return {
      tooltip: pieTooltip,
      legend: { bottom: 0, textStyle: { color: "#64748b", fontSize: 11 }, itemWidth: 10, itemHeight: 10 },
      series: [
        {
          type: "pie",
          radius: ["52%", "74%"],
          center: ["50%", "45%"],
          label: {
            show: true,
            position: "center",
            formatter: `{total|${sign}${fmtMoney(total, 0)}}\n{unit|总资产 (${display})}`,
            rich: {
              total: { fontSize: 20, fontWeight: 800, color: "#0f172a", lineHeight: 26 },
              unit: { fontSize: 10, color: "#94a3b8", lineHeight: 16 },
            },
          },
          labelLine: { show: false },
          itemStyle: { borderRadius: 5, borderColor: "#ffffff", borderWidth: 1.5 },
          emphasis: {
            scaleSize: 4,
            itemStyle: { borderWidth: 1.5, shadowBlur: 10, shadowColor: "rgba(15,23,42,.15)" },
          },
          data: [
            { ...summary.allocation.positionVsCash[0], itemStyle: { color: "#eab308" } },
            { ...summary.allocation.positionVsCash[1], itemStyle: { color: "#3b82f6" } },
          ],
          animationType: "scale",
          animationEasing: "elasticOut",
          animationDelay: (i: number) => i * 80,
        },
      ],
    };
  }, [summary, display, sign, pieTooltip]);

  const sidePie = useCallback(
    (data: Array<{ name: string; value: number }>, colorAt: (name: string, i: number) => string): EChartsOption => ({
      tooltip: pieTooltip,
      legend: {
        orient: "vertical",
        right: 6,
        top: "middle",
        textStyle: { color: "#64748b", fontSize: 11 },
        itemWidth: 10,
        itemHeight: 10,
        itemGap: 8,
      },
      series: [
        {
          type: "pie",
          radius: ["46%", "72%"],
          center: ["36%", "50%"],
          avoidLabelOverlap: false,
          label: { show: false },
          labelLine: { show: false },
          itemStyle: { borderRadius: 4, borderColor: "#ffffff", borderWidth: 1.5 },
          emphasis: {
            scaleSize: 4,
            itemStyle: { borderWidth: 1.5, shadowBlur: 10, shadowColor: "rgba(15,23,42,.15)" },
          },
          data: data.map((item, i) => ({ ...item, itemStyle: { color: colorAt(item.name, i) } })),
          animationType: "scale",
          animationEasing: "elasticOut",
          animationDelay: (i: number) => i * 80,
        },
      ],
    }),
    [pieTooltip],
  );

  const symbolPieOption = useMemo<EChartsOption>(() => {
    if (!summary) return {};
    // 标的太多时聚合尾部为「其他」
    const items = summary.allocation.bySymbol;
    const top = items.slice(0, 9);
    const rest = items.slice(9).reduce((sum, item) => sum + item.value, 0);
    const data = rest > 0 ? [...top, { name: "其他", value: Math.round(rest * 100) / 100 }] : top;
    return sidePie(data, (_, i) => PALETTE[i % PALETTE.length]);
  }, [summary, sidePie]);

  const BUCKET_COLORS: Record<string, string> = {
    进取仓: "#f97316",
    防守仓: "#3b82f6",
    稳健仓: "#22c55e",
    未分类: "#94a3b8",
  };

  const bucketPieOption = useMemo<EChartsOption>(() => {
    if (!summary) return {};
    return sidePie(summary.allocation.byBucket, (name, i) => BUCKET_COLORS[name] ?? PALETTE[i % PALETTE.length]);
  }, [summary, sidePie]);

  const historyOption = useMemo<EChartsOption>(() => {
    if (!summary) return {};
    const history = summary.history;
    return {
      tooltip: {
        ...LIGHT_TOOLTIP,
        trigger: "axis",
        formatter: (params: any) => {
          const i = params[0].dataIndex;
          const h = history[i];
          const gl = h.gainLossDisplay;
          return [
            `<b>${h.month}</b>（${h.symbolCount} 只标的）`,
            `市值：${sign}${fmtMoney(h.valueDisplay)}`,
            `总成本：${sign}${fmtMoney(h.costDisplay)}`,
            `盈亏：<b style="color:${gl >= 0 ? "#16a34a" : "#ef4444"}">${gl >= 0 ? "+" : ""}${sign}${fmtMoney(gl)}</b>`,
          ].join("<br/>");
        },
      },
      legend: { top: 0, textStyle: { color: "#64748b", fontSize: 11 } },
      grid: { left: 10, right: 10, top: 34, bottom: 8, containLabel: true },
      xAxis: {
        type: "category",
        data: history.map((h) => h.month),
        axisLabel: { color: "#64748b", fontSize: 10 },
        axisLine: { lineStyle: { color: "#e2e8f0" } },
        axisTick: { show: false },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: "#94a3b8", fontSize: 10 },
        splitLine: { lineStyle: { color: "#f1f5f9" } },
      },
      series: [
        {
          name: "盈亏",
          type: "bar",
          barWidth: 22,
          data: history.map((h) => ({
            value: Math.round(h.gainLossDisplay * 100) / 100,
            itemStyle: {
              color: gradientBarVertical(h.gainLossDisplay >= 0 ? "#22c55e" : "#ef4444"),
              borderRadius: h.gainLossDisplay >= 0 ? [6, 6, 0, 0] : [0, 0, 6, 6],
            },
          })),
          animationDuration: 900,
          animationEasing: "cubicOut",
          animationDelay: (i: number) => i * 70,
        },
        {
          name: "总成本",
          type: "line",
          smooth: 0.3,
          data: history.map((h) => Math.round(h.costDisplay * 100) / 100),
          lineStyle: { color: "#8b5cf6", width: 2, type: "dashed" },
          itemStyle: { color: "#8b5cf6" },
          symbol: "circle",
          symbolSize: 6,
        },
        {
          name: "市值",
          type: "line",
          smooth: 0.3,
          data: history.map((h) => Math.round(h.valueDisplay * 100) / 100),
          lineStyle: { color: "#eab308", width: 2 },
          itemStyle: { color: "#eab308" },
          symbol: "circle",
          symbolSize: 6,
        },
      ],
    };
  }, [summary, sign]);

  const radarOption = useMemo<EChartsOption>(() => {
    if (!summary) return {};
    return {
      tooltip: { ...LIGHT_TOOLTIP },
      radar: {
        indicator: summary.radar.map((r) => ({ name: r.name, max: 100 })),
        center: ["50%", "52%"],
        radius: "68%",
        axisName: { color: "#64748b", fontSize: 10, fontWeight: 600 },
        splitArea: { areaStyle: { color: ["rgba(241,245,249,.7)", "rgba(241,245,249,.35)"] } },
        axisLine: { lineStyle: { color: "rgba(226,232,240,.9)" } },
        splitLine: { lineStyle: { color: "rgba(226,232,240,.9)" } },
      },
      series: [
        {
          type: "radar",
          data: [
            {
              value: summary.radar.map((r) => r.value),
              name: "账户结构",
              lineStyle: { color: "#eab308", width: 2.5, shadowBlur: 8, shadowColor: "rgba(234,179,8,.35)" },
              areaStyle: {
                color: {
                  type: "radial",
                  x: 0.5,
                  y: 0.5,
                  r: 0.5,
                  colorStops: [
                    { offset: 0, color: "rgba(234,179,8,.28)" },
                    { offset: 1, color: "rgba(234,179,8,.05)" },
                  ],
                },
              },
              itemStyle: { color: "#eab308", borderColor: "#fbbf24", borderWidth: 2 },
              symbol: "circle",
              symbolSize: 7,
            },
          ],
          animationDuration: 1200,
          animationEasing: "cubicOut",
        },
      ],
    };
  }, [summary]);

  const saveManualCash = async () => {
    if (!cashForm.broker || cashForm.amount === "") return;
    setCashSaving(true);
    try {
      await api.put("/api/cash", {
        broker: cashForm.broker,
        currency: cashForm.currency,
        amount: Number(cashForm.amount),
      });
      setCashForm({ broker: "", currency: "USD", amount: "" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "保存失败");
    } finally {
      setCashSaving(false);
    }
  };

  if (busy) {
    return (
      <div className="empty">
        <span className="spin dark" />
      </div>
    );
  }

  const kpi = summary?.kpi;
  const glRatioText =
    kpi == null || kpi.totalCost === 0
      ? "—"
      : kpi.gainLossRatio == null
        ? "已回本"
        : `${kpi.gainLossRatio >= 0 ? "+" : ""}${(kpi.gainLossRatio * 100).toFixed(1)}%`;

  return (
    <div className="fade-in">
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <h1 className="page-title">资产盘点</h1>
          <p className="page-desc">
            {summary?.asOf.length
              ? `数据基准：${summary.asOf.map((a) => `${a.broker} @ ${a.asOf}`).join(" · ")}`
              : "录入持仓后即可查看仓位与现金盘点"}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select className="select" style={{ width: 110 }} value={display} onChange={(e) => setDisplay(e.target.value as Currency)}>
            <option value="USD">USD 计价</option>
            <option value="HKD">HKD 计价</option>
            <option value="CNY">CNY 计价</option>
          </select>
          <button className="btn ghost" disabled={refreshing || !hasData} onClick={() => load(true)}>
            {refreshing ? <span className="spin dark" /> : "↻ 刷新市值"}
          </button>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}
      {summary && summary.staleQuotes.length > 0 && (
        <div className="alert warn">以下标的未获取到最新行情，仍使用原市值：{summary.staleQuotes.join("、")}</div>
      )}

      {!hasData ? (
        <div className="card empty">
          <div className="icon">📄</div>
          还没有任何持仓数据。
          <div style={{ marginTop: 14 }}>
            <Link to="/holdings" className="btn">
              去录入持仓
            </Link>
          </div>
        </div>
      ) : (
        summary &&
        kpi && (
          <>
            <div className="grid grid-5" style={{ marginBottom: 16 }}>
              <div className="kpi">
                <div className="k">总资产</div>
                <div className="v">
                  {sign}
                  {fmtMoney(kpi.totalAssets, 0)}
                  <span className="unit">{display}</span>
                </div>
              </div>
              <div className="kpi ok">
                <div className="k">持仓市值</div>
                <div className="v">
                  {sign}
                  {fmtMoney(kpi.positionsValue, 0)}
                </div>
                <div className={`sub ${kpi.gainLoss >= 0 ? "pos" : "neg"}`}>
                  盈亏 {kpi.gainLoss >= 0 ? "+" : ""}
                  {sign}
                  {fmtMoney(kpi.gainLoss, 0)}（{glRatioText}）
                </div>
              </div>
              <div className="kpi violet">
                <div className="k">总资产成本</div>
                <div className="v">
                  {sign}
                  {fmtMoney(kpi.totalCost, 0)}
                </div>
                <div className="sub">股票净投入（买入−卖出，含手续费）</div>
              </div>
              <div className="kpi blue">
                <div className="k">闲置现金</div>
                <div className="v">
                  {sign}
                  {fmtMoney(kpi.idleCash, 0)}
                </div>
                <div className="sub">{summary.cash.length} 个币种账户</div>
              </div>
              <div className="kpi accent">
                <div className="k">仓位现金比</div>
                <div className="v">
                  {(kpi.positionRatio * 100).toFixed(1)}
                  <span className="unit">% 仓位</span>
                </div>
                <div className="sub">现金 {((1 - kpi.positionRatio) * 100).toFixed(1)}%</div>
              </div>
            </div>

            <div className="grid grid-3" style={{ marginBottom: 16 }}>
              <div className="card">
                <div className="card-h">
                  仓位 vs 现金<span className="tag">甜甜圈</span>
                </div>
                <Chart option={donutOption} height={270} />
              </div>
              <div className="card">
                <div className="card-h">
                  标的市值分布<span className="tag">Top 9 + 其他</span>
                </div>
                <Chart option={symbolPieOption} height={270} />
              </div>
              <div className="card">
                <div className="card-h">
                  三仓市值分布<span className="tag">进取 / 防守 / 稳健</span>
                </div>
                <Chart option={bucketPieOption} height={270} />
                {summary.allocation.byBucket.some((b) => b.name === "未分类") && (
                  <p style={{ fontSize: 11, color: "var(--ink-4)", marginTop: 4 }}>
                    在 <Link to="/holdings" style={{ color: "var(--brand)", fontWeight: 600 }}>持仓明细</Link> 中为标的标注仓别
                  </p>
                )}
              </div>
            </div>

            <div className="grid grid-2" style={{ marginBottom: 16 }}>
              <div className="card">
                <div className="card-h">
                  近 1 年资产盈亏<span className="tag">柱=盈亏 · 虚线=总成本 · 实线=市值</span>
                </div>
                {summary.history.length === 0 ? (
                  <div className="empty">暂无历史快照，上传不同月份的月结单后自动生成</div>
                ) : (
                  <Chart option={historyOption} height={320} />
                )}
              </div>
              <div className="card">
                <div className="card-h">
                  账户结构画像<span className="tag">结构描述，非预测</span>
                </div>
                <Chart option={radarOption} height={320} />
              </div>
            </div>

            <div className="card">
              <div className="card-h">
                闲置现金<span className="tag">手动值覆盖解析值</span>
              </div>
              <table className="table">
                <thead>
                  <tr>
                    <th>券商</th>
                    <th>币种</th>
                    <th className="num">金额</th>
                    <th className="num">折算 ({display})</th>
                    <th>来源</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.cash.map((c) => (
                    <tr key={`${c.broker}-${c.currency}`}>
                      <td>{c.broker}</td>
                      <td>{c.currency}</td>
                      <td className="num">{fmtMoney(c.amount)}</td>
                      <td className="num">{fmtMoney(c.amountDisplay)}</td>
                      <td>
                        <span className={`chip ${c.source === "manual" ? "warn" : "gray"}`}>
                          {c.source === "manual" ? "手动" : "解析"}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {summary.cash.length === 0 && (
                    <tr>
                      <td colSpan={5} style={{ color: "var(--ink-4)", textAlign: "center" }}>
                        暂无现金记录，可在下方手动补录
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center", flexWrap: "wrap" }}>
                <input
                  className="input sm"
                  style={{ width: 110 }}
                  placeholder="券商（如 ibkr）"
                  value={cashForm.broker}
                  onChange={(e) => setCashForm({ ...cashForm, broker: e.target.value })}
                />
                <select
                  className="select"
                  style={{ width: 84, padding: "5px 8px", fontSize: 12 }}
                  value={cashForm.currency}
                  onChange={(e) => setCashForm({ ...cashForm, currency: e.target.value as Currency })}
                >
                  <option>USD</option>
                  <option>HKD</option>
                  <option>CNY</option>
                </select>
                <input
                  className="input sm"
                  style={{ width: 120 }}
                  placeholder="金额"
                  type="number"
                  value={cashForm.amount}
                  onChange={(e) => setCashForm({ ...cashForm, amount: e.target.value })}
                />
                <button className="btn sm" disabled={cashSaving || !cashForm.broker || cashForm.amount === ""} onClick={saveManualCash}>
                  {cashSaving ? <span className="spin" /> : "补录现金"}
                </button>
              </div>
            </div>
          </>
        )
      )}
    </div>
  );
}
