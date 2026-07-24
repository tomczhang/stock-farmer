import type { EChartsOption } from "echarts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import { Chart, fmtMoney, gradientBar, LIGHT_TOOLTIP, PALETTE } from "../components/Chart";
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

  const donutOption = useMemo<EChartsOption>(() => {
    if (!summary) return {};
    const total = summary.kpi.totalAssets;
    return {
      tooltip: {
        ...LIGHT_TOOLTIP,
        formatter: (p: any) =>
          `<b>${p.name}</b><br/>${sign}${fmtMoney(p.value)}<br/>占比：${p.percent}%`,
      },
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
          itemStyle: { borderRadius: 5, borderColor: "#ffffff", borderWidth: 3 },
          emphasis: { itemStyle: { shadowBlur: 14, shadowColor: "rgba(15,23,42,.18)" } },
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
  }, [summary, display, sign]);

  const brokerPieOption = useMemo<EChartsOption>(() => {
    if (!summary) return {};
    return {
      tooltip: {
        ...LIGHT_TOOLTIP,
        formatter: (p: any) =>
          `<b>${p.name}</b><br/>${sign}${fmtMoney(p.value)}<br/>占比：${p.percent}%`,
      },
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
          itemStyle: { borderRadius: 4, borderColor: "#ffffff", borderWidth: 2 },
          emphasis: { itemStyle: { shadowBlur: 14, shadowColor: "rgba(15,23,42,.18)" } },
          data: summary.allocation.byBroker.map((item, i) => ({
            ...item,
            itemStyle: { color: PALETTE[i % PALETTE.length] },
          })),
          animationType: "scale",
          animationEasing: "elasticOut",
          animationDelay: (i: number) => i * 80,
        },
      ],
    };
  }, [summary, sign]);

  const currencyPieOption = useMemo<EChartsOption>(() => {
    if (!summary) return {};
    return {
      tooltip: {
        ...LIGHT_TOOLTIP,
        formatter: (p: any) =>
          `<b>${p.name}</b><br/>${sign}${fmtMoney(p.value)}<br/>占比：${p.percent}%`,
      },
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
          label: { show: false },
          labelLine: { show: false },
          itemStyle: { borderRadius: 4, borderColor: "#ffffff", borderWidth: 2 },
          emphasis: { itemStyle: { shadowBlur: 14, shadowColor: "rgba(15,23,42,.18)" } },
          data: summary.allocation.byCurrency.map((item, i) => ({
            ...item,
            itemStyle: { color: [PALETTE[3], PALETTE[0], PALETTE[2]][i % 3] },
          })),
          animationType: "scale",
          animationEasing: "elasticOut",
          animationDelay: (i: number) => i * 80,
        },
      ],
    };
  }, [summary, sign]);

  const topBarsOption = useMemo<EChartsOption>(() => {
    if (!summary) return {};
    const top = summary.positions.slice(0, 10).reverse();
    return {
      tooltip: {
        ...LIGHT_TOOLTIP,
        formatter: (p: any) => {
          const pos = top[p.dataIndex];
          const gl = pos.gainLossDisplay;
          const glText =
            gl == null
              ? "—"
              : `<span style="color:${gl >= 0 ? "#16a34a" : "#ef4444"}">${gl >= 0 ? "+" : ""}${sign}${fmtMoney(gl)}</span>`;
          return `<b>${pos.symbol}</b> ${pos.name}<br/>市值：${sign}${fmtMoney(pos.valueDisplay)}<br/>浮动盈亏：${glText}`;
        },
      },
      grid: { left: 8, right: 60, top: 8, bottom: 8, containLabel: true },
      xAxis: {
        type: "value",
        axisLabel: { color: "#94a3b8", fontSize: 10 },
        splitLine: { lineStyle: { color: "#f1f5f9" } },
      },
      yAxis: {
        type: "category",
        data: top.map((p) => p.symbol),
        axisLabel: { color: "#334155", fontSize: 11, fontWeight: 600 },
        axisLine: { lineStyle: { color: "#e2e8f0" } },
        axisTick: { show: false },
      },
      series: [
        {
          type: "bar",
          barWidth: 16,
          data: top.map((p) => ({
            value: Math.round(p.valueDisplay * 100) / 100,
            itemStyle: {
              color: gradientBar((p.gainLossDisplay ?? 0) >= 0 ? "#22c55e" : "#ef4444"),
              borderRadius: [0, 6, 6, 0],
            },
          })),
          label: {
            show: true,
            position: "right",
            color: "#64748b",
            fontSize: 10,
            formatter: (p: any) => `${sign}${fmtMoney(p.value, 0)}`,
          },
          animationDuration: 900,
          animationEasing: "cubicOut",
          animationDelay: (i: number) => i * 60,
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

  return (
    <div className="fade-in">
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <h1 className="page-title">资产盘点</h1>
          <p className="page-desc">
            {summary?.asOf.length
              ? `数据基准：${summary.asOf.map((a) => `${a.broker} @ ${a.asOf}`).join(" · ")}`
              : "上传月结单后即可查看仓位与现金盘点"}
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
        <div className="alert warn">以下标的未获取到最新行情，仍使用月结单市值：{summary.staleQuotes.join("、")}</div>
      )}

      {!hasData ? (
        <div className="card empty">
          <div className="icon">📄</div>
          还没有任何持仓数据。
          <div style={{ marginTop: 14 }}>
            <Link to="/statements" className="btn">
              上传第一份月结单
            </Link>
          </div>
        </div>
      ) : (
        summary && (
          <>
            <div className="grid grid-4" style={{ marginBottom: 16 }}>
              <div className="kpi">
                <div className="k">总资产</div>
                <div className="v">
                  {sign}
                  {fmtMoney(summary.kpi.totalAssets, 0)}
                  <span className="unit">{display}</span>
                </div>
              </div>
              <div className="kpi ok">
                <div className="k">持仓市值</div>
                <div className="v">
                  {sign}
                  {fmtMoney(summary.kpi.positionsValue, 0)}
                </div>
                <div className="sub">{summary.positions.length} 只标的</div>
              </div>
              <div className="kpi blue">
                <div className="k">闲置现金</div>
                <div className="v">
                  {sign}
                  {fmtMoney(summary.kpi.idleCash, 0)}
                </div>
                <div className="sub">{summary.cash.length} 个币种账户</div>
              </div>
              <div className="kpi accent">
                <div className="k">仓位现金比</div>
                <div className="v">
                  {(summary.kpi.positionRatio * 100).toFixed(1)}
                  <span className="unit">% 仓位</span>
                </div>
                <div className="sub">现金 {((1 - summary.kpi.positionRatio) * 100).toFixed(1)}%</div>
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
                  券商分布<span className="tag">含现金</span>
                </div>
                <Chart option={brokerPieOption} height={270} />
              </div>
              <div className="card">
                <div className="card-h">
                  币种分布<span className="tag">持仓口径</span>
                </div>
                <Chart option={currencyPieOption} height={270} />
              </div>
            </div>

            <div className="grid grid-2" style={{ marginBottom: 16 }}>
              <div className="card">
                <div className="card-h">
                  个股市值 Top 10<span className="tag">绿涨红跌着色</span>
                </div>
                <Chart option={topBarsOption} height={320} />
              </div>
              <div className="card">
                <div className="card-h">
                  账户结构画像<span className="tag">结构描述，非预测</span>
                </div>
                <Chart option={radarOption} height={320} />
              </div>
            </div>

            <div className="grid grid-2">
              <div className="card">
                <div className="card-h">持仓明细</div>
                <div style={{ maxHeight: 360, overflowY: "auto" }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>标的</th>
                        <th>券商</th>
                        <th className="num">数量</th>
                        <th className="num">市值 ({display})</th>
                        <th className="num">浮动盈亏</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.positions.map((p) => (
                        <tr key={`${p.broker}-${p.symbol}`}>
                          <td>
                            <b>{p.symbol}</b>
                            <span style={{ color: "var(--ink-4)", fontSize: 11, marginLeft: 6 }}>{p.name}</span>
                            {p.quoteApplied && <span className="chip ok" style={{ marginLeft: 6 }}>已刷新</span>}
                          </td>
                          <td>{p.broker}</td>
                          <td className="num">{fmtMoney(p.quantity, 0)}</td>
                          <td className="num">{fmtMoney(p.valueDisplay)}</td>
                          <td className={`num ${p.gainLossDisplay == null ? "" : p.gainLossDisplay >= 0 ? "pos" : "neg"}`}>
                            {p.gainLossDisplay == null
                              ? "—"
                              : `${p.gainLossDisplay >= 0 ? "+" : ""}${fmtMoney(p.gainLossDisplay)}`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
            </div>
          </>
        )
      )}
    </div>
  );
}
