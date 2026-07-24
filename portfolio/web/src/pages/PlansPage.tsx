import type { EChartsOption } from "echarts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import { Chart, fmtMoney, gradientBarVertical, LIGHT_TOOLTIP } from "../components/Chart";
import { TradingViewWidget } from "../components/TradingViewWidget";
import type { Currency, Plan } from "../types";

interface TierDraft {
  seq: number;
  triggerType: "pct_drop" | "price";
  triggerValue: string;
  allocType: "pct" | "amount";
  allocValue: string;
}

interface PlanDraft {
  id?: number;
  symbol: string;
  name: string;
  market: string;
  currency: Currency;
  basePrice: string;
  totalBudget: string;
  note: string;
  tiers: TierDraft[];
}

const DEFAULT_TIERS: TierDraft[] = [
  { seq: 1, triggerType: "pct_drop", triggerValue: "10", allocType: "pct", allocValue: "10" },
  { seq: 2, triggerType: "pct_drop", triggerValue: "20", allocType: "pct", allocValue: "20" },
  { seq: 3, triggerType: "pct_drop", triggerValue: "30", allocType: "pct", allocValue: "30" },
  { seq: 4, triggerType: "pct_drop", triggerValue: "40", allocType: "pct", allocValue: "40" },
];

const EMPTY_DRAFT: PlanDraft = {
  symbol: "",
  name: "",
  market: "US",
  currency: "USD",
  basePrice: "",
  totalBudget: "",
  note: "",
  tiers: DEFAULT_TIERS,
};

export default function PlansPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<PlanDraft | null>(null);
  const [saving, setSaving] = useState(false);

  const selected = useMemo(() => plans.find((p) => p.id === selectedId) ?? null, [plans, selectedId]);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const data = await api.get<Plan[]>("/api/plans");
      setPlans(data);
      setSelectedId((prev) => (prev && data.some((p) => p.id === prev) ? prev : (data[0]?.id ?? null)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "加载失败");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openEdit = (plan?: Plan) => {
    if (!plan) {
      setDraft({ ...EMPTY_DRAFT, tiers: DEFAULT_TIERS.map((t) => ({ ...t })) });
      return;
    }
    setDraft({
      id: plan.id,
      symbol: plan.symbol,
      name: plan.name,
      market: plan.market,
      currency: plan.currency,
      basePrice: String(plan.basePrice),
      totalBudget: String(plan.totalBudget),
      note: plan.note ?? "",
      tiers: plan.tiers.map((t) => ({
        seq: t.seq,
        triggerType: t.triggerType,
        triggerValue: String(t.triggerValue),
        allocType: t.allocType,
        allocValue: String(t.allocValue),
      })),
    });
  };

  const savePlan = async () => {
    if (!draft) return;
    setSaving(true);
    setError("");
    try {
      const payload = {
        symbol: draft.symbol,
        name: draft.name || draft.symbol,
        market: draft.market,
        currency: draft.currency,
        basePrice: Number(draft.basePrice),
        totalBudget: Number(draft.totalBudget),
        note: draft.note || undefined,
        tiers: draft.tiers.map((t, i) => ({
          seq: i + 1,
          triggerType: t.triggerType,
          triggerValue: Number(t.triggerValue),
          allocType: t.allocType,
          allocValue: Number(t.allocValue),
        })),
      };
      const saved = draft.id
        ? await api.put<Plan>(`/api/plans/${draft.id}`, payload)
        : await api.post<Plan>("/api/plans", payload);
      setDraft(null);
      await load();
      setSelectedId(saved.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const removePlan = async (id: number) => {
    if (!window.confirm("确定删除该加仓计划？")) return;
    try {
      await api.delete(`/api/plans/${id}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "删除失败");
    }
  };

  const toggleFill = async (plan: Plan, tierId: number, filled: boolean) => {
    try {
      await api.put(`/api/plans/${plan.id}/tiers/${tierId}/fill`, { filled });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "操作失败");
    }
  };

  const ladderOption = useMemo<EChartsOption>(() => {
    if (!selected) return {};
    const tiers = selected.tiers;
    return {
      tooltip: {
        ...LIGHT_TOOLTIP,
        trigger: "axis",
        formatter: (params: any) => {
          const i = params[0].dataIndex;
          const t = tiers[i];
          return [
            `<b>第 ${t.seq} 档</b>${t.filledAt ? '<span style="color:#16a34a">（已成交）</span>' : ""}`,
            `买入价：${fmtMoney(t.buyPrice)}`,
            `投入：${fmtMoney(t.amount)}（${fmtMoney(t.shares, 0)} 股）`,
            `累计投入：${fmtMoney(t.cumulativeAmount)}`,
            `摊薄成本：${fmtMoney(t.avgCost)}`,
          ].join("<br/>");
        },
      },
      legend: { top: 0, textStyle: { color: "#64748b", fontSize: 11 } },
      grid: { left: 10, right: 10, top: 36, bottom: 8, containLabel: true },
      xAxis: {
        type: "category",
        data: tiers.map((t) => `第${t.seq}档`),
        axisLabel: { color: "#334155", fontSize: 11, fontWeight: 600 },
        axisLine: { lineStyle: { color: "#e2e8f0" } },
        axisTick: { show: false },
      },
      yAxis: [
        {
          type: "value",
          name: "投入金额",
          nameTextStyle: { color: "#94a3b8", fontSize: 10 },
          axisLabel: { color: "#94a3b8", fontSize: 10 },
          splitLine: { lineStyle: { color: "#f1f5f9" } },
        },
        {
          type: "value",
          name: "价格",
          nameTextStyle: { color: "#94a3b8", fontSize: 10 },
          axisLabel: { color: "#94a3b8", fontSize: 10 },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: "每档投入",
          type: "bar",
          barWidth: 34,
          data: tiers.map((t) => ({
            value: t.amount,
            itemStyle: {
              color: gradientBarVertical(t.filledAt ? "#22c55e" : "#eab308"),
              borderRadius: [6, 6, 0, 0],
            },
          })),
          label: {
            show: true,
            position: "top",
            fontSize: 10,
            color: "#64748b",
            formatter: (p: any) => fmtMoney(p.value, 0),
          },
          animationDuration: 900,
          animationEasing: "cubicOut",
          animationDelay: (i: number) => i * 90,
        },
        {
          name: "买入价",
          type: "line",
          yAxisIndex: 1,
          data: tiers.map((t) => t.buyPrice),
          lineStyle: { color: "#f97316", width: 2 },
          itemStyle: { color: "#f97316" },
          symbol: "circle",
          symbolSize: 7,
        },
        {
          name: "摊薄成本",
          type: "line",
          yAxisIndex: 1,
          data: tiers.map((t) => t.avgCost),
          lineStyle: { color: "#3b82f6", width: 2, type: "dashed" },
          itemStyle: { color: "#3b82f6" },
          symbol: "diamond",
          symbolSize: 8,
        },
      ],
    };
  }, [selected]);

  return (
    <div className="fade-in">
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
        <div style={{ flex: 1 }}>
          <h1 className="page-title">金字塔加仓计划</h1>
          <p className="page-desc">设定基准价与总预算，按档位分批加仓；每档跌幅/价格与仓位均可自定义。</p>
        </div>
        <button className="btn" onClick={() => openEdit()}>
          + 新建计划
        </button>
      </div>

      {error && <div className="alert error">{error}</div>}

      {busy ? (
        <div className="empty">
          <span className="spin dark" />
        </div>
      ) : plans.length === 0 && !draft ? (
        <div className="card empty">
          <div className="icon">🏗️</div>
          还没有加仓计划。点击右上角「新建计划」开始。
        </div>
      ) : (
        <>
          {plans.length > 0 && (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
              {plans.map((p) => (
                <div
                  key={p.id}
                  className={`broker-item ${p.id === selectedId ? "active" : ""}`}
                  style={{ minWidth: 200 }}
                  onClick={() => setSelectedId(p.id)}
                >
                  <div className="name">
                    {p.symbol} <span style={{ color: "var(--ink-4)", fontWeight: 400 }}>{p.name}</span>
                  </div>
                  <div className="hint">
                    基准 {fmtMoney(p.basePrice)} · 预算 {fmtMoney(p.totalBudget, 0)} {p.currency} · 已投{" "}
                    {((p.filledAmount / (p.totalPlanned || 1)) * 100).toFixed(0)}%
                  </div>
                </div>
              ))}
            </div>
          )}

          {selected && !draft && (
            <>
              {selected.warning && <div className="alert warn">{selected.warning}</div>}
              <div className="grid grid-2" style={{ marginBottom: 16 }}>
                <div className="card">
                  <div className="card-h">
                    加仓阶梯<span className="tag">柱=每档投入 · 虚线=摊薄成本</span>
                    <span style={{ flex: 1 }} />
                    <button className="btn ghost sm" onClick={() => openEdit(selected)}>
                      编辑
                    </button>
                    <button className="btn danger sm" onClick={() => removePlan(selected.id)}>
                      删除
                    </button>
                  </div>
                  <Chart option={ladderOption} height={300} />
                  <table className="table" style={{ marginTop: 10 }}>
                    <thead>
                      <tr>
                        <th>档位</th>
                        <th>触发</th>
                        <th className="num">买入价</th>
                        <th className="num">投入</th>
                        <th className="num">累计投入</th>
                        <th className="num">摊薄成本</th>
                        <th>已成交</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.tiers.map((t) => (
                        <tr key={t.id} style={t.filledAt ? { background: "var(--ok-bg)" } : undefined}>
                          <td>
                            <b>第 {t.seq} 档</b>
                          </td>
                          <td>
                            {t.triggerType === "pct_drop" ? `跌 ${t.triggerValue}%` : `价格 ${fmtMoney(t.triggerValue)}`}
                          </td>
                          <td className="num">{fmtMoney(t.buyPrice)}</td>
                          <td className="num">
                            {fmtMoney(t.amount, 0)}
                            <span style={{ color: "var(--ink-4)", fontSize: 11 }}>
                              （{t.allocType === "pct" ? `${t.allocValue}%` : "固定"}）
                            </span>
                          </td>
                          <td className="num">{fmtMoney(t.cumulativeAmount, 0)}</td>
                          <td className="num">{fmtMoney(t.avgCost)}</td>
                          <td>
                            <input
                              type="checkbox"
                              checked={!!t.filledAt}
                              onChange={(e) => toggleFill(selected, t.id, e.target.checked)}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p style={{ fontSize: 11, color: "var(--ink-4)", marginTop: 10 }}>
                    合计投入 {fmtMoney(selected.totalPlanned, 0)} {selected.currency}，已成交{" "}
                    {fmtMoney(selected.filledAmount, 0)} {selected.currency}
                    {selected.note ? ` · 备注：${selected.note}` : ""}
                  </p>
                </div>
                <div className="card">
                  <div className="card-h">
                    行情走势<span className="tag">TradingView</span>
                  </div>
                  <TradingViewWidget symbol={selected.symbol} market={selected.market} height={560} />
                </div>
              </div>
            </>
          )}
        </>
      )}

      {draft && (
        <div className="card fade-in" style={{ marginTop: 4 }}>
          <div className="card-h">{draft.id ? `编辑计划：${draft.symbol}` : "新建加仓计划"}</div>
          <div className="grid grid-4" style={{ marginBottom: 4 }}>
            <div className="field">
              <label>标的代码</label>
              <input
                className="input"
                placeholder="如 AAPL / 09988"
                value={draft.symbol}
                onChange={(e) => setDraft({ ...draft, symbol: e.target.value })}
              />
            </div>
            <div className="field">
              <label>名称（可选）</label>
              <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div className="field">
              <label>市场</label>
              <select
                className="select"
                value={draft.market}
                onChange={(e) => {
                  const market = e.target.value;
                  setDraft({ ...draft, market, currency: market === "HK" ? "HKD" : "USD" });
                }}
              >
                <option value="US">美股</option>
                <option value="HK">港股</option>
              </select>
            </div>
            <div className="field">
              <label>币种</label>
              <select
                className="select"
                value={draft.currency}
                onChange={(e) => setDraft({ ...draft, currency: e.target.value as Currency })}
              >
                <option>USD</option>
                <option>HKD</option>
                <option>CNY</option>
              </select>
            </div>
          </div>
          <div className="grid grid-4" style={{ marginBottom: 12 }}>
            <div className="field">
              <label>基准价（如现价或前高）</label>
              <input
                className="input"
                type="number"
                value={draft.basePrice}
                onChange={(e) => setDraft({ ...draft, basePrice: e.target.value })}
              />
            </div>
            <div className="field">
              <label>总预算（{draft.currency}）</label>
              <input
                className="input"
                type="number"
                value={draft.totalBudget}
                onChange={(e) => setDraft({ ...draft, totalBudget: e.target.value })}
              />
            </div>
            <div className="field" style={{ gridColumn: "span 2" }}>
              <label>备注（可选）</label>
              <input className="input" value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
            </div>
          </div>

          <div className="card-h">档位设置</div>
          <table className="table" style={{ marginBottom: 12 }}>
            <thead>
              <tr>
                <th style={{ width: 60 }}>档位</th>
                <th>触发方式</th>
                <th>触发值</th>
                <th>仓位方式</th>
                <th>仓位值</th>
                <th style={{ width: 110 }} />
              </tr>
            </thead>
            <tbody>
              {draft.tiers.map((t, i) => (
                <tr key={i}>
                  <td>
                    <b>第 {i + 1} 档</b>
                  </td>
                  <td>
                    <select
                      className="select"
                      style={{ width: 140, padding: "5px 8px", fontSize: 12 }}
                      value={t.triggerType}
                      onChange={(e) => {
                        const next = [...draft.tiers];
                        next[i] = { ...t, triggerType: e.target.value as TierDraft["triggerType"] };
                        setDraft({ ...draft, tiers: next });
                      }}
                    >
                      <option value="pct_drop">较基准价跌幅 %</option>
                      <option value="price">具体价格</option>
                    </select>
                  </td>
                  <td>
                    <input
                      className="input sm"
                      style={{ width: 100 }}
                      type="number"
                      placeholder={t.triggerType === "pct_drop" ? "如 10" : "如 85.5"}
                      value={t.triggerValue}
                      onChange={(e) => {
                        const next = [...draft.tiers];
                        next[i] = { ...t, triggerValue: e.target.value };
                        setDraft({ ...draft, tiers: next });
                      }}
                    />
                  </td>
                  <td>
                    <select
                      className="select"
                      style={{ width: 130, padding: "5px 8px", fontSize: 12 }}
                      value={t.allocType}
                      onChange={(e) => {
                        const next = [...draft.tiers];
                        next[i] = { ...t, allocType: e.target.value as TierDraft["allocType"] };
                        setDraft({ ...draft, tiers: next });
                      }}
                    >
                      <option value="pct">占预算 %</option>
                      <option value="amount">固定金额</option>
                    </select>
                  </td>
                  <td>
                    <input
                      className="input sm"
                      style={{ width: 100 }}
                      type="number"
                      placeholder={t.allocType === "pct" ? "如 20" : "如 5000"}
                      value={t.allocValue}
                      onChange={(e) => {
                        const next = [...draft.tiers];
                        next[i] = { ...t, allocValue: e.target.value };
                        setDraft({ ...draft, tiers: next });
                      }}
                    />
                  </td>
                  <td>
                    <button
                      className="btn ghost sm"
                      disabled={i === 0}
                      onClick={() => {
                        const next = [...draft.tiers];
                        [next[i - 1], next[i]] = [next[i], next[i - 1]];
                        setDraft({ ...draft, tiers: next });
                      }}
                    >
                      ↑
                    </button>
                    <button
                      className="btn danger sm"
                      disabled={draft.tiers.length <= 1}
                      onClick={() => setDraft({ ...draft, tiers: draft.tiers.filter((_, j) => j !== i) })}
                    >
                      删
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            className="btn ghost sm"
            style={{ marginBottom: 16 }}
            onClick={() =>
              setDraft({
                ...draft,
                tiers: [
                  ...draft.tiers,
                  { seq: draft.tiers.length + 1, triggerType: "pct_drop", triggerValue: "", allocType: "pct", allocValue: "" },
                ],
              })
            }
          >
            + 添加档位
          </button>

          <div style={{ display: "flex", gap: 10 }}>
            <button
              className="btn"
              disabled={saving || !draft.symbol || !draft.basePrice || !draft.totalBudget}
              onClick={savePlan}
            >
              {saving ? <span className="spin" /> : "保存计划"}
            </button>
            <button className="btn ghost" onClick={() => setDraft(null)}>
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
