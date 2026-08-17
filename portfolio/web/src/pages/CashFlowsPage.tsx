import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { fmtMoney } from "../components/Chart";
import type {
  CapitalEvent,
  CapitalEventInput,
  CapitalEventType,
  CashFlowEvent,
  CashFlowEventInput,
  CashFlowEventType,
  CashFlowResult,
  Currency,
  Summary,
} from "../types";

const today = () => new Date().toISOString().slice(0, 10);

const CAPITAL_LABELS: Record<CapitalEventType, string> = {
  cash_in: "现金注入",
  cash_out: "现金调减",
  transfer_in: "转仓入",
  transfer_out: "转仓出",
  adjustment: "人工调整",
};

const FLOW_LABELS: Record<CashFlowEventType, string> = {
  dividend: "股息",
  realized_gain: "已实现资本利得",
  trade_fee: "交易费用",
  financing_fee: "融资费用",
};

const EMPTY_CAPITAL: CapitalEventInput = {
  type: "cash_in",
  eventDate: today(),
  currency: "USD",
  amount: undefined,
  market: "US",
  source: "manual",
};

const EMPTY_FLOW: CashFlowEventInput = {
  type: "dividend",
  eventDate: today(),
  currency: "USD",
  market: "US",
  grossAmount: 0,
  source: "manual",
};

function signed(value: number, currency: Currency | "USD" = "USD") {
  return `${value >= 0 ? "+" : "-"}${fmtMoney(Math.abs(value))} ${currency}`;
}

function flowTypeLabel(type: string) {
  if (type in CAPITAL_LABELS) return CAPITAL_LABELS[type as CapitalEventType];
  if (type in FLOW_LABELS) return FLOW_LABELS[type as CashFlowEventType];
  if (type === "buy") return "买入";
  if (type === "sell") return "卖出";
  return type;
}

export default function CashFlowsPage() {
  const [capitalEvents, setCapitalEvents] = useState<CapitalEvent[]>([]);
  const [cashFlowEvents, setCashFlowEvents] = useState<CashFlowEvent[]>([]);
  const [flows, setFlows] = useState<CashFlowResult | null>(null);
  const [portfolioSummary, setPortfolioSummary] = useState<Summary | null>(null);
  const [mode, setMode] = useState<"capital" | "income">("capital");
  const [capitalDraft, setCapitalDraft] = useState<CapitalEventInput>(EMPTY_CAPITAL);
  const [flowDraft, setFlowDraft] = useState<CashFlowEventInput>(EMPTY_FLOW);
  const [filters, setFilters] = useState({ from: "", to: "", category: "", symbol: "" });
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const loadSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setBusy(true);
    setError("");
    try {
      const query = new URLSearchParams();
      if (filters.from) query.set("from", filters.from);
      if (filters.to) query.set("to", filters.to);
      if (filters.category) query.set("category", filters.category);
      if (filters.symbol) query.set("symbol", filters.symbol.trim().toUpperCase());
      const suffix = query.size ? `?${query.toString()}` : "";
      const [capital, income, all, summary] = await Promise.all([
        api.get<CapitalEvent[]>("/api/capital-events"),
        api.get<CashFlowEvent[]>("/api/cash-flow-events"),
        api.get<CashFlowResult>(`/api/cash-flows${suffix}`),
        api.get<Summary>("/api/portfolio/summary?display=USD"),
      ]);
      if (sequence !== loadSequence.current) return;
      setCapitalEvents(capital);
      setCashFlowEvents(income);
      setFlows(all);
      setPortfolioSummary(summary);
    } catch (err) {
      if (sequence === loadSequence.current) setError(err instanceof ApiError ? err.message : "现金流加载失败");
    } finally {
      if (sequence === loadSequence.current) setBusy(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  const externalNetInvested = portfolioSummary?.costs?.externalNetInvested ?? null;

  const saveCapital = async () => {
    setSaving(true);
    setError("");
    try {
      const symbol = capitalDraft.symbol?.trim().toUpperCase() || undefined;
      await api.post("/api/capital-events", {
        ...capitalDraft,
        market: symbol ? capitalDraft.market : undefined,
        symbol,
        amount: capitalNeedsPosition || capitalDraft.amount == null ? undefined : Number(capitalDraft.amount),
        quantity: capitalNeedsPosition && capitalDraft.quantity != null ? Number(capitalDraft.quantity) : undefined,
        unitCost: capitalNeedsPosition && capitalDraft.unitCost != null ? Number(capitalDraft.unitCost) : undefined,
      });
      setCapitalDraft({ ...EMPTY_CAPITAL, eventDate: today() });
      setNotice("资本事件已保存；普通买卖不会改变外部净投入。");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "资本事件保存失败");
    } finally {
      setSaving(false);
    }
  };

  const saveFlow = async () => {
    setSaving(true);
    setError("");
    try {
      await api.post("/api/cash-flow-events", {
        ...flowDraft,
        symbol: flowDraft.symbol?.trim().toUpperCase() || undefined,
        market: flowDraft.symbol?.trim() ? flowDraft.market : undefined,
        grossAmount: Number(flowDraft.grossAmount),
        taxAmount: Number(flowDraft.taxAmount ?? 0),
        feeAmount: Number(flowDraft.feeAmount ?? 0),
      });
      setFlowDraft({ ...EMPTY_FLOW, eventDate: today() });
      setNotice("收益或费用事件已保存。");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "现金流事件保存失败");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (kind: "capital" | "income", id: number) => {
    if (!window.confirm("确定删除这条事件？相关汇总会立即重算。")) return;
    try {
      await api.delete(`/${kind === "capital" ? "api/capital-events" : "api/cash-flow-events"}/${id}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "删除失败");
    }
  };

  // 订正转仓事件的单位成本（券商继承成本 ≠ 真实成本时使用）
  const [costEdit, setCostEdit] = useState<{ id: number; value: string } | null>(null);

  const saveCostEdit = async (event: CapitalEvent) => {
    const parsed = Number(costEdit?.value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError("订正的单位成本需为正数");
      return;
    }
    setSaving(true);
    setError("");
    try {
      // 备注里保留最早的原始成本，重复订正不覆盖首次记录
      const noteBase = (event.note ?? "").replace(/；?成本订正（原 [^）]*）/g, "");
      const original = (event.note ?? "").match(/成本订正（原 ([^）]*)）/)?.[1] ?? String(event.unitCost ?? "");
      await api.put(`/api/capital-events/${event.id}`, {
        type: event.type,
        eventDate: event.eventDate,
        broker: event.broker || undefined,
        market: event.market || undefined,
        symbol: event.symbol || undefined,
        name: event.name || undefined,
        currency: event.currency,
        amount: event.amount ?? undefined,
        quantity: event.quantity ?? undefined,
        unitCost: parsed,
        source: event.source || "manual",
        sourceId: event.sourceId || undefined,
        note: [noteBase || null, `成本订正（原 ${original}）`].filter(Boolean).join("；"),
      });
      setCostEdit(null);
      setNotice(`${event.symbol ?? ""} 转仓单位成本已订正为 ${parsed}，外部净投入已重算。`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "成本订正失败");
    } finally {
      setSaving(false);
    }
  };

  const capitalNeedsPosition = capitalDraft.type === "transfer_in" || capitalDraft.type === "transfer_out";
  const capitalReady = capitalDraft.eventDate && (capitalNeedsPosition
    ? !!capitalDraft.symbol && !!capitalDraft.market && Number(capitalDraft.quantity) > 0 && Number(capitalDraft.unitCost) > 0
    : Number(capitalDraft.amount) > 0 && (!capitalDraft.symbol?.trim() || !!capitalDraft.market));
  const flowAmountReady = flowDraft.type === "realized_gain"
    ? Number(flowDraft.grossAmount) !== 0
    : Number(flowDraft.grossAmount) > 0;

  return (
    <div className="fade-in">
      <div className="page-heading-row">
        <div>
          <h1 className="page-title">现金流</h1>
          <p className="page-desc">外部净投入只由资本事件改变；买卖、股息和费用单独对账。</p>
        </div>
      </div>

      {error && <div className="alert error" role="alert">{error}</div>}
      {notice && <div className="alert ok" role="status">{notice}</div>}

      <section className="grid grid-4 cashflow-kpis" aria-label="现金流汇总">
        <div className="kpi violet">
          <div className="k">外部净投入</div>
          <div className="v">{externalNetInvested == null ? "待初始化" : `$${fmtMoney(externalNetInvested, 0)}`}</div>
          <div className="sub">仅资本事件 · USD 基准</div>
        </div>
        <div className="kpi ok">
          <div className="k">外部流入</div>
          <div className="v">${fmtMoney(flows?.summary.externalIn ?? 0, 0)}</div>
        </div>
        <div className="kpi accent">
          <div className="k">股息净流入</div>
          <div className="v">${fmtMoney(flows?.summary.dividend ?? 0, 0)}</div>
        </div>
        <div className="kpi blue">
          <div className="k">当前筛选净现金</div>
          <div className={`v ${(flows?.summary.netCash ?? 0) >= 0 ? "pos" : "neg"}`}>
            {signed(flows?.summary.netCash ?? 0)}
          </div>
          <div className="sub">费用 ${fmtMoney(flows?.summary.fees ?? 0)}</div>
        </div>
      </section>

      <section className="card section-card" aria-labelledby="cash-entry-title">
        <div className="card-h" id="cash-entry-title">事件录入<span className="tag">可审计</span></div>
        <div className="auth-tabs compact-tabs" role="tablist" aria-label="事件类型">
          <button role="tab" aria-selected={mode === "capital"} className={mode === "capital" ? "active" : ""} onClick={() => setMode("capital")}>外部资本</button>
          <button role="tab" aria-selected={mode === "income"} className={mode === "income" ? "active" : ""} onClick={() => setMode("income")}>收益与费用</button>
        </div>

        {mode === "capital" ? (
          <div className="event-form-grid">
            <div className="field"><label htmlFor="capital-type">类型</label><select id="capital-type" className="select" value={capitalDraft.type} onChange={(e) => setCapitalDraft({ ...capitalDraft, type: e.target.value as CapitalEventType })}>{Object.entries(CAPITAL_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
            <div className="field"><label htmlFor="capital-date">日期</label><input id="capital-date" className="input" type="date" value={capitalDraft.eventDate} onChange={(e) => setCapitalDraft({ ...capitalDraft, eventDate: e.target.value })} /></div>
            <div className="field"><label htmlFor="capital-currency">币种</label><select id="capital-currency" className="select" value={capitalDraft.currency} onChange={(e) => setCapitalDraft({ ...capitalDraft, currency: e.target.value as Currency })}><option>USD</option><option>HKD</option><option>CNY</option></select></div>
            <div className="field"><label htmlFor="capital-symbol">标的（{capitalNeedsPosition ? "必填" : "可选"}）</label><input id="capital-symbol" className="input" placeholder="留空则计入账户整体" value={capitalDraft.symbol ?? ""} onChange={(e) => setCapitalDraft({ ...capitalDraft, symbol: e.target.value })} /></div>
            {(capitalNeedsPosition || capitalDraft.symbol?.trim()) && <div className="field"><label htmlFor="capital-market">市场</label><select id="capital-market" className="select" value={capitalDraft.market ?? "US"} onChange={(e) => setCapitalDraft({ ...capitalDraft, market: e.target.value })}><option value="US">美股</option><option value="HK">港股</option><option value="CN">A 股</option></select></div>}
            {capitalNeedsPosition ? (
              <>
                <div className="field"><label htmlFor="capital-quantity">数量</label><input id="capital-quantity" className="input" type="number" min="0" value={capitalDraft.quantity ?? ""} onChange={(e) => setCapitalDraft({ ...capitalDraft, quantity: e.target.value === "" ? undefined : Number(e.target.value) })} /></div>
                <div className="field"><label htmlFor="capital-unit-cost">确认单位成本</label><input id="capital-unit-cost" className="input" type="number" min="0" value={capitalDraft.unitCost ?? ""} onChange={(e) => setCapitalDraft({ ...capitalDraft, unitCost: e.target.value === "" ? undefined : Number(e.target.value) })} /></div>
              </>
            ) : (
              <div className="field"><label htmlFor="capital-amount">本金金额</label><input id="capital-amount" className="input" type="number" min="0" value={capitalDraft.amount ?? ""} onChange={(e) => setCapitalDraft({ ...capitalDraft, amount: e.target.value === "" ? undefined : Number(e.target.value) })} /></div>
            )}
            <div className="field field-wide"><label htmlFor="capital-note">备注</label><input id="capital-note" className="input" value={capitalDraft.note ?? ""} onChange={(e) => setCapitalDraft({ ...capitalDraft, note: e.target.value })} /></div>
            <div className="event-form-action"><button className="btn" disabled={saving || !capitalReady} onClick={saveCapital}>{saving ? <span className="spin" /> : "保存资本事件"}</button></div>
          </div>
        ) : (
          <div className="event-form-grid">
            <div className="field"><label htmlFor="flow-type">类型</label><select id="flow-type" className="select" value={flowDraft.type} onChange={(e) => setFlowDraft({ ...flowDraft, type: e.target.value as CashFlowEventType })}>{Object.entries(FLOW_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
            <div className="field"><label htmlFor="flow-date">日期</label><input id="flow-date" className="input" type="date" value={flowDraft.eventDate} onChange={(e) => setFlowDraft({ ...flowDraft, eventDate: e.target.value })} /></div>
            <div className="field"><label htmlFor="flow-currency">币种</label><select id="flow-currency" className="select" value={flowDraft.currency} onChange={(e) => setFlowDraft({ ...flowDraft, currency: e.target.value as Currency })}><option>USD</option><option>HKD</option><option>CNY</option></select></div>
            <div className="field"><label htmlFor="flow-symbol">标的（可选）</label><input id="flow-symbol" className="input" value={flowDraft.symbol ?? ""} onChange={(e) => setFlowDraft({ ...flowDraft, symbol: e.target.value })} /></div>
            {flowDraft.symbol?.trim() && <div className="field"><label htmlFor="flow-market">市场</label><select id="flow-market" className="select" value={flowDraft.market ?? "US"} onChange={(e) => setFlowDraft({ ...flowDraft, market: e.target.value })}><option value="US">美股</option><option value="HK">港股</option><option value="CN">A 股</option></select></div>}
            <div className="field"><label htmlFor="flow-gross">金额{flowDraft.type === "realized_gain" ? "（亏损填负数）" : ""}</label><input id="flow-gross" className="input" type="number" min={flowDraft.type === "realized_gain" ? undefined : 0} value={flowDraft.grossAmount || ""} onChange={(e) => setFlowDraft({ ...flowDraft, grossAmount: Number(e.target.value) })} /></div>
            <div className="field"><label htmlFor="flow-tax">税费</label><input id="flow-tax" className="input" type="number" min="0" value={flowDraft.taxAmount ?? ""} onChange={(e) => setFlowDraft({ ...flowDraft, taxAmount: e.target.value === "" ? undefined : Number(e.target.value) })} /></div>
            <div className="field"><label htmlFor="flow-fee">其他费用</label><input id="flow-fee" className="input" type="number" min="0" value={flowDraft.feeAmount ?? ""} onChange={(e) => setFlowDraft({ ...flowDraft, feeAmount: e.target.value === "" ? undefined : Number(e.target.value) })} /></div>
            <div className="field field-wide"><label htmlFor="flow-note">备注</label><input id="flow-note" className="input" value={flowDraft.note ?? ""} onChange={(e) => setFlowDraft({ ...flowDraft, note: e.target.value })} /></div>
            <div className="event-form-action"><button className="btn" disabled={saving || !flowDraft.eventDate || !flowAmountReady || (!!flowDraft.symbol?.trim() && !flowDraft.market)} onClick={saveFlow}>{saving ? <span className="spin" /> : "保存收益/费用"}</button></div>
          </div>
        )}
      </section>

      <section className="card section-card" aria-labelledby="flow-detail-title">
        <div className="card-h" id="flow-detail-title">现金流明细<span className="tag">买卖不改变净投入</span></div>
        <div className="filter-row">
          <div className="field"><label htmlFor="filter-from">开始日期</label><input id="filter-from" className="input sm" type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></div>
          <div className="field"><label htmlFor="filter-to">结束日期</label><input id="filter-to" className="input sm" type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></div>
          <div className="field"><label htmlFor="filter-category">类别</label><select id="filter-category" className="select sm" value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value })}><option value="">全部</option><option value="capital">外部资本</option><option value="trade">买卖</option><option value="dividend">股息</option><option value="realized_gain">已实现资本利得</option><option value="fee">费用</option></select></div>
          <div className="field"><label htmlFor="filter-symbol">标的</label><input id="filter-symbol" className="input sm" placeholder="全部" value={filters.symbol} onChange={(e) => setFilters({ ...filters, symbol: e.target.value })} /></div>
        </div>
        {busy ? <div className="empty"><span className="spin dark" /></div> : (
          <div className="table-scroll" tabIndex={0} aria-label="现金流明细，可横向滚动">
            <table className="table">
              <thead><tr><th>日期</th><th>类别</th><th>标的</th><th>币种</th><th className="num">现金影响</th><th className="num">盈亏影响</th><th>来源</th></tr></thead>
              <tbody>
                {(flows?.items ?? []).map((item) => <tr key={`${item.category}-${item.id}`}><td>{item.eventDate}</td><td><span className="chip gray">{flowTypeLabel(item.type)}</span></td><td>{item.symbol ?? "整体"}</td><td>{item.currency}</td><td className={`num ${item.cashImpact >= 0 ? "pos" : "neg"}`}>{signed(item.cashImpact, item.currency)}</td><td className={`num ${item.pnlImpact >= 0 ? "pos" : "neg"}`}>{signed(item.pnlImpact, item.currency)}</td><td>{item.source}</td></tr>)}
                {(flows?.items.length ?? 0) === 0 && <tr><td colSpan={7} className="table-empty">当前筛选没有现金流</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <details className="card event-ledger-details">
        <summary>管理事件（{capitalEvents.length + cashFlowEvents.length} 条）</summary>
        <div className="table-scroll" tabIndex={0}>
          <table className="table">
            <thead><tr><th>日期</th><th>类型</th><th>标的</th><th className="num">净投入/盈亏影响</th><th /></tr></thead>
            <tbody>
              {capitalEvents.map((event) => {
                const isTransfer = event.type === "transfer_in" || event.type === "transfer_out";
                const editing = costEdit?.id === event.id;
                return (
                  <tr key={`capital-${event.id}`}>
                    <td>{event.eventDate}</td>
                    <td>{CAPITAL_LABELS[event.type]}</td>
                    <td>
                      {event.symbol ?? "整体"}
                      {isTransfer && event.quantity != null && <span className="chip gray">{fmtMoney(event.quantity, 0)} 股 @ {fmtMoney(event.unitCost ?? 0)}</span>}
                    </td>
                    <td className="num">
                      {editing ? (
                        <input
                          className="input sm"
                          type="number"
                          min="0"
                          step="any"
                          autoFocus
                          aria-label="订正单位成本"
                          value={costEdit.value}
                          onChange={(e) => setCostEdit({ id: event.id, value: e.target.value })}
                          onKeyDown={(e) => { if (e.key === "Enter") void saveCostEdit(event); if (e.key === "Escape") setCostEdit(null); }}
                        />
                      ) : signed(event.netInvestedImpact, event.currency)}
                    </td>
                    <td>
                      {isTransfer && (editing ? (
                        <>
                          <button className="btn sm" disabled={saving} onClick={() => void saveCostEdit(event)}>保存</button>
                          <button className="btn ghost sm" onClick={() => setCostEdit(null)}>取消</button>
                        </>
                      ) : (
                        <button className="btn ghost sm" onClick={() => setCostEdit({ id: event.id, value: String(event.unitCost ?? "") })}>订正成本</button>
                      ))}
                      {!editing && <button className="btn danger sm" onClick={() => remove("capital", event.id)}>删除</button>}
                    </td>
                  </tr>
                );
              })}
              {cashFlowEvents.map((event) => <tr key={`income-${event.id}`}><td>{event.eventDate}</td><td>{FLOW_LABELS[event.type]}</td><td>{event.symbol ?? "整体"}</td><td className="num">{signed(event.pnlImpact, event.currency)}</td><td><button className="btn danger sm" onClick={() => remove("income", event.id)}>删除</button></td></tr>)}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
