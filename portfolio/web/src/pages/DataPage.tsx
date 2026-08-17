import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { fmtMoney } from "../components/Chart";
import { analyzeStatementFiles, BROKERS, type BrokerId } from "../lib/parse/analyze";
import type { DividendIncome, RealizedTrade, TradeActivity } from "../lib/tax/types";
import { type Currency, type StatementRow, type Summary, type SummaryCash, type TradeRow } from "../types";

interface PreviewPosition {
  market: string;
  currency: string;
  symbol: string;
  name: string;
  quantity: number;
  marketValue: number;
  costBasis: number | null;
  unrealizedGl: number | null;
}

interface PreviewCash {
  currency: string;
  amount: string;
  fromParse: boolean;
}

interface TradeForm {
  broker: string;
  market: string;
  currency: Currency;
  symbol: string;
  name: string;
  side: "buy" | "sell";
  tradeDate: string;
  quantity: string;
  price: string;
  fee: string;
  reason: string;
}

const EMPTY_TRADE: TradeForm = {
  broker: "",
  market: "US",
  currency: "USD",
  symbol: "",
  name: "",
  side: "buy",
  tradeDate: new Date().toISOString().slice(0, 10),
  quantity: "",
  price: "",
  fee: "",
  reason: "",
};

interface CashForm {
  broker: string;
  currency: Currency;
  amount: string;
  asOf: string;
  outside: boolean;
}

const EMPTY_CASH: CashForm = {
  broker: "",
  currency: "USD",
  amount: "",
  asOf: new Date().toISOString().slice(0, 10),
  outside: false,
};

/** 券商外自由现金（银行/活期）在库内的虚拟券商标识。 */
const FREE_CASH_BROKER = "自有资金";

function transferNeedsConfirmation(activity: TradeActivity, confirmedTransfers: string[]) {
  return (activity.side === "transfer_in" || activity.side === "transfer_out")
    && (!confirmedTransfers.includes(activity.id) || !(activity.quantity > 0) || !activity.unitPrice || activity.unitPrice <= 0);
}

export default function DataPage() {
  const [statements, setStatements] = useState<StatementRow[]>([]);
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [entryMode, setEntryMode] = useState<"statement" | "trade" | "cash">("statement");

  // 手动交易表单
  const [tradeForm, setTradeForm] = useState<TradeForm>(EMPTY_TRADE);
  const [tradeSaving, setTradeSaving] = useState(false);

  // 补录现金表单
  const [cashForm, setCashForm] = useState<CashForm>(EMPTY_CASH);
  const [cashSaving, setCashSaving] = useState(false);
  const [cashRows, setCashRows] = useState<SummaryCash[]>([]);

  // 上传向导状态
  const [broker, setBroker] = useState<BrokerId | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [password, setPassword] = useState("");
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [drag, setDrag] = useState(false);
  const [preview, setPreview] = useState<{
    positions: PreviewPosition[];
    cash: PreviewCash[];
    tradeActivities: TradeActivity[];
    realizedTrades: RealizedTrade[];
    dividends: DividendIncome[];
    confirmedTransfers: string[];
    asOf: string;
    issues: Array<{ severity: string; title: string; detail: string }>;
  } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const brokerMeta = useMemo(() => BROKERS.find((b) => b.id === broker), [broker]);
  const step = preview ? 3 : files.length > 0 ? 2 : broker ? 2 : 1;

  const loadAll = useCallback(async () => {
    setBusy(true);
    try {
      const [st, tr, summary] = await Promise.all([
        api.get<StatementRow[]>("/api/statements"),
        api.get<TradeRow[]>("/api/trades"),
        api.get<Summary>("/api/portfolio/summary?display=USD"),
      ]);
      setStatements(st);
      setTrades(tr);
      setCashRows(summary.cash ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "加载失败");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const submitTrade = async () => {
    setTradeSaving(true);
    setError("");
    try {
      await api.post("/api/trades", {
        broker: tradeForm.broker || "manual",
        market: tradeForm.market,
        currency: tradeForm.currency,
        symbol: tradeForm.symbol,
        name: tradeForm.name || undefined,
        side: tradeForm.side,
        tradeDate: tradeForm.tradeDate,
        quantity: Number(tradeForm.quantity),
        price: Number(tradeForm.price),
        fee: tradeForm.fee === "" ? 0 : Number(tradeForm.fee),
        reason: tradeForm.reason.trim() || undefined,
      });
      setNotice(`已录入 ${tradeForm.side === "buy" ? "买入" : "卖出"} ${tradeForm.symbol.toUpperCase()}`);
      setTradeForm({ ...EMPTY_TRADE, broker: tradeForm.broker, market: tradeForm.market, currency: tradeForm.currency });
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "录入失败");
    } finally {
      setTradeSaving(false);
    }
  };

  const removeTrade = async (id: number) => {
    if (!window.confirm("确定删除这笔交易记录？")) return;
    try {
      await api.delete(`/api/trades/${id}`);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "删除失败");
    }
  };

  const submitCash = async () => {
    setCashSaving(true);
    setError("");
    try {
      const broker = cashForm.outside ? FREE_CASH_BROKER : cashForm.broker.trim();
      await api.put("/api/cash", {
        broker,
        currency: cashForm.currency,
        amount: Number(cashForm.amount),
        asOf: cashForm.asOf,
      });
      setNotice(cashForm.outside
        ? `已补录券商外自由现金 ${cashForm.amount} ${cashForm.currency}，已计入总资产与闲置现金。`
        : `已补录 ${broker} 现金 ${cashForm.amount} ${cashForm.currency}，将覆盖该券商同币种的月结单口径。`);
      setCashForm({ ...EMPTY_CASH, broker: cashForm.broker, currency: cashForm.currency, outside: cashForm.outside });
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "现金补录失败");
    } finally {
      setCashSaving(false);
    }
  };

  const clearManualCash = async (broker: string, currency: string, hasParsed: boolean) => {
    const hint = hasParsed
      ? `清除 ${broker} 的 ${currency} 手动现金记录，恢复月结单解析口径？`
      : `删除 ${broker} 的 ${currency} 现金记录？`;
    if (!window.confirm(hint)) return;
    try {
      await api.delete(`/api/cash?broker=${encodeURIComponent(broker)}&currency=${encodeURIComponent(currency)}`);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "清除失败");
    }
  };

  const resetWizard = () => {
    setFiles([]);
    setPassword("");
    setPreview(null);
  };

  const addFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    setPreview(null);
    setFiles((prev) => {
      const merged = [...prev];
      for (const file of Array.from(incoming)) {
        if (!merged.some((f) => f.name === file.name && f.size === file.size)) merged.push(file);
      }
      return merged;
    });
  };

  const parse = async () => {
    if (!broker) return;
    setParsing(true);
    setError("");
    setNotice("");
    try {
      const result = await analyzeStatementFiles({ broker, files, password: password || undefined });
      if (result.positions.length === 0) {
        setNotice("解析完成，但未在文件中找到持仓记录（可能是纯交易流水报表）。仍可手动确认现金后保存。");
      }
      const unresolvedDividendSymbols = Array.from(new Set(result.dividends.map((dividend) => dividend.symbol))).filter((symbol) => {
        const markets = new Set([
          ...result.positions.filter((position) => position.symbol === symbol).map((position) => position.market),
          ...result.tradeActivities.filter((activity) => activity.symbol === symbol).map((activity) => activity.market),
        ].filter(Boolean));
        return markets.size !== 1;
      });
      setPreview({
        positions: result.positions.map((p) => ({
          market: p.market,
          currency: p.currency,
          symbol: p.symbol,
          name: p.securityName,
          quantity: p.quantity,
          marketValue: p.marketValue,
          costBasis: p.costBasis ?? null,
          unrealizedGl: p.unrealizedGainLoss ?? null,
        })),
        cash:
          result.cashBalances.length > 0
            ? result.cashBalances.map((c) => ({ currency: c.currency, amount: String(c.amount), fromParse: true }))
            : [{ currency: "USD", amount: "", fromParse: false }],
        tradeActivities: result.tradeActivities,
        realizedTrades: result.realizedTrades,
        dividends: result.dividends,
        confirmedTransfers: [],
        asOf: result.asOf,
        issues: [
          ...result.issues.filter((issue) => issue.severity !== "info").slice(0, 5),
          ...unresolvedDividendSymbols.map((symbol) => ({
            severity: "warning",
            title: `${symbol} 股息市场待归属`,
            detail: "持仓与交易中无法唯一确定市场；本次仍保存事件，但不会猜测归属。",
          })),
        ],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "解析失败");
    } finally {
      setParsing(false);
    }
  };

  const save = async () => {
    if (!broker || !preview) return;
    const unresolvedTransferCount = preview.tradeActivities.filter((activity) => transferNeedsConfirmation(activity, preview.confirmedTransfers)).length;
    setSaving(true);
    setError("");
    try {
      const marketForSymbol = (symbol: string) => {
        const normalizedSymbol = symbol.trim().toUpperCase();
        const markets = new Set([
          ...preview.positions
            .filter((position) => position.symbol.trim().toUpperCase() === normalizedSymbol)
            .map((position) => position.market),
          ...preview.tradeActivities
            .filter((activity) => activity.symbol.trim().toUpperCase() === normalizedSymbol)
            .map((activity) => activity.market),
        ].filter(Boolean));
        return markets.size === 1 ? Array.from(markets)[0] : undefined;
      };
      await api.post("/api/statements", {
        broker,
        fileName: files.map((f) => f.name).join(", "),
        asOf: preview.asOf,
        positions: preview.positions.map((p) => ({ ...p, broker })),
        cashBalances: preview.cash
          .filter((c) => c.amount !== "" && Number.isFinite(Number(c.amount)))
          .map((c) => ({ broker, currency: c.currency, amount: Number(c.amount) })),
        tradeActivities: preview.tradeActivities.map((activity) => ({
          ...activity,
          capitalConfirmed: preview.confirmedTransfers.includes(activity.id),
        })),
        realizedTrades: preview.realizedTrades,
        dividends: preview.dividends.map(({ evidence: _evidence, ...dividend }) => ({
          ...dividend,
          market: marketForSymbol(dividend.symbol),
        })),
      });
      setNotice(`已保存 ${brokerMeta?.label} @ ${preview.asOf} 快照${unresolvedTransferCount > 0 ? `；${unresolvedTransferCount} 条未确认转仓已跳过资本入账` : ""}`);
      resetWizard();
      setBroker(null);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const removeStatement = async (id: number) => {
    if (!window.confirm("确定删除该快照？对应的持仓、现金，以及由该快照导入的交易、股息、已实现盈亏和转仓资本事件将一并删除。")) return;
    try {
      await api.delete(`/api/statements/${id}`);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "删除失败");
    }
  };

  const unresolvedTransferCount = preview?.tradeActivities.filter((activity) => transferNeedsConfirmation(activity, preview.confirmedTransfers)).length ?? 0;

  if (busy) {
    return (
      <div className="empty">
        <span className="spin dark" aria-label="正在加载数据" />
      </div>
    );
  }

  return (
    <div className="fade-in">
      <h1 className="page-title">数据管理</h1>
      <p className="page-desc">
        月结单和交易流水只在浏览器内解析，保存结构化数据；原始文件和密码不会上传。
      </p>

      {error && <div className="alert error" role="alert">{error}</div>}
      {notice && <div className="alert ok" role="status">{notice}</div>}

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-h">录入</div>
        <div className="auth-tabs" style={{ maxWidth: 480 }} role="tablist" aria-label="数据录入方式">
          <button id="entry-tab-statement" type="button" role="tab" aria-selected={entryMode === "statement"} aria-controls="entry-panel-statement" className={entryMode === "statement" ? "active" : ""} onClick={() => setEntryMode("statement")}>
            上传月结单
          </button>
          <button id="entry-tab-trade" type="button" role="tab" aria-selected={entryMode === "trade"} aria-controls="entry-panel-trade" className={entryMode === "trade" ? "active" : ""} onClick={() => setEntryMode("trade")}>
            手动录入交易
          </button>
          <button id="entry-tab-cash" type="button" role="tab" aria-selected={entryMode === "cash"} aria-controls="entry-panel-cash" className={entryMode === "cash" ? "active" : ""} onClick={() => setEntryMode("cash")}>
            补录现金
          </button>
        </div>

        {entryMode === "cash" ? (
          <div id="entry-panel-cash" className="fade-in" role="tabpanel" aria-labelledby="entry-tab-cash">
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="manual-cash-outside">资金位置</label>
                <select id="manual-cash-outside" className="select" style={{ width: 150, padding: "5px 8px", fontSize: 12 }} value={cashForm.outside ? "outside" : "broker"}
                  onChange={(e) => setCashForm({ ...cashForm, outside: e.target.value === "outside" })}>
                  <option value="broker">券商账户内</option>
                  <option value="outside">券商外自由现金</option>
                </select>
              </div>
              {!cashForm.outside && (
                <div className="field" style={{ marginBottom: 0 }}>
                  <label htmlFor="manual-cash-broker">券商</label>
                  <input id="manual-cash-broker" className="input sm" style={{ width: 110 }} placeholder="如 IBKR / Futu" value={cashForm.broker}
                    onChange={(e) => setCashForm({ ...cashForm, broker: e.target.value })} list="cash-broker-options" />
                  <datalist id="cash-broker-options">
                    {Array.from(new Set(cashRows.map((c) => c.broker))).filter((b) => b !== FREE_CASH_BROKER).map((b) => <option key={b} value={b} />)}
                  </datalist>
                </div>
              )}
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="manual-cash-currency">币种</label>
                <select id="manual-cash-currency" className="select" style={{ width: 80, padding: "5px 8px", fontSize: 12 }} value={cashForm.currency}
                  onChange={(e) => setCashForm({ ...cashForm, currency: e.target.value as Currency })}>
                  <option>USD</option>
                  <option>HKD</option>
                  <option>CNY</option>
                </select>
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="manual-cash-amount">金额</label>
                <input id="manual-cash-amount" className="input sm" style={{ width: 120 }} type="number" step="any" value={cashForm.amount}
                  onChange={(e) => setCashForm({ ...cashForm, amount: e.target.value })} />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="manual-cash-asof">截至日期</label>
                <input id="manual-cash-asof" className="input sm" style={{ width: 130 }} type="date" value={cashForm.asOf}
                  onChange={(e) => setCashForm({ ...cashForm, asOf: e.target.value })} />
              </div>
              <button className="btn sm" style={{ height: 32 }}
                disabled={cashSaving || (!cashForm.outside && !cashForm.broker.trim()) || cashForm.amount === "" || !Number.isFinite(Number(cashForm.amount))}
                onClick={submitCash}>
                {cashSaving ? <span className="spin" /> : "保存现金"}
              </button>
            </div>
            <p className="helper-text">
              券商内：手动值会持续覆盖对应券商+币种的月结单解析值，直到点击“恢复解析”；券商外自由现金以“{FREE_CASH_BROKER}”记账，同样计入总资产/闲置现金与加仓安全线。两者都只影响现金余额展示，不改变外部净投入（入金/出金请去现金流页记资本事件）。
            </p>
            {cashRows.length > 0 && (
              <div className="table-scroll" tabIndex={0} aria-label="当前现金余额">
                <table className="table">
                  <thead><tr><th>位置</th><th>币种</th><th className="num">金额</th><th>口径</th><th>截至</th><th /></tr></thead>
                  <tbody>
                    {cashRows.map((c) => {
                      const hasParsed = statements.some((s) => s.broker === c.broker);
                      const isFund = c.source === "money_fund";
                      return (
                        <tr key={`${c.broker}-${c.currency}-${c.label ?? "cash"}`}>
                          <td>
                            <b>{c.broker}</b>
                            {isFund && <span style={{ color: "var(--ink-4)", fontSize: 11, marginLeft: 6 }}>{c.label}</span>}
                          </td>
                          <td>{c.currency}</td>
                          <td className="num">{fmtMoney(c.amount)}</td>
                          <td><span className={`chip ${c.source === "manual" ? "warn" : isFund ? "gray" : "ok"}`}>{c.source === "manual" ? (hasParsed ? "手动覆盖" : "手动记账") : isFund ? "货币基金·视同现金" : "月结单解析"}</span></td>
                          <td>{c.asOf}</td>
                          <td>
                            {c.source === "manual" && (
                              <button className="btn ghost sm" onClick={() => clearManualCash(c.broker, c.currency, hasParsed)}>{hasParsed ? "恢复解析" : "删除"}</button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : entryMode === "trade" ? (
          <div id="entry-panel-trade" className="fade-in" role="tabpanel" aria-labelledby="entry-tab-trade">
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="manual-trade-broker">券商</label>
                <input id="manual-trade-broker" className="input sm" style={{ width: 90 }} placeholder="如 ibkr" value={tradeForm.broker}
                  onChange={(e) => setTradeForm({ ...tradeForm, broker: e.target.value })} />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="manual-trade-market">市场</label>
                <select id="manual-trade-market" className="select" style={{ width: 80, padding: "5px 8px", fontSize: 12 }} value={tradeForm.market}
                  onChange={(e) => {
                    const market = e.target.value;
                    setTradeForm({ ...tradeForm, market, currency: market === "HK" ? "HKD" : "USD" });
                  }}>
                  <option value="US">美股</option>
                  <option value="HK">港股</option>
                </select>
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="manual-trade-symbol">标的</label>
                <input id="manual-trade-symbol" className="input sm" style={{ width: 90 }} placeholder="AAPL / 00700" value={tradeForm.symbol}
                  onChange={(e) => setTradeForm({ ...tradeForm, symbol: e.target.value })} />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="manual-trade-side">方向</label>
                <select id="manual-trade-side" className="select" style={{ width: 76, padding: "5px 8px", fontSize: 12 }} value={tradeForm.side}
                  onChange={(e) => setTradeForm({ ...tradeForm, side: e.target.value as "buy" | "sell" })}>
                  <option value="buy">买入</option>
                  <option value="sell">卖出</option>
                </select>
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="manual-trade-date">日期</label>
                <input id="manual-trade-date" className="input sm" style={{ width: 130 }} type="date" value={tradeForm.tradeDate}
                  onChange={(e) => setTradeForm({ ...tradeForm, tradeDate: e.target.value })} />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="manual-trade-quantity">数量</label>
                <input id="manual-trade-quantity" className="input sm" style={{ width: 80 }} type="number" value={tradeForm.quantity}
                  onChange={(e) => setTradeForm({ ...tradeForm, quantity: e.target.value })} />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="manual-trade-price">成交价（{tradeForm.currency}）</label>
                <input id="manual-trade-price" className="input sm" style={{ width: 100 }} type="number" value={tradeForm.price}
                  onChange={(e) => setTradeForm({ ...tradeForm, price: e.target.value })} />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="manual-trade-fee">手续费</label>
                <input id="manual-trade-fee" className="input sm" style={{ width: 80 }} type="number" placeholder="0" value={tradeForm.fee}
                  onChange={(e) => setTradeForm({ ...tradeForm, fee: e.target.value })} />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="manual-trade-reason">交易原因</label>
                <input id="manual-trade-reason" className="input sm" style={{ width: 180 }} placeholder="如：阶梯-10%触发加速" value={tradeForm.reason}
                  onChange={(e) => setTradeForm({ ...tradeForm, reason: e.target.value })} />
              </div>
              <button className="btn sm" style={{ height: 32 }}
                disabled={tradeSaving || !tradeForm.symbol || !tradeForm.quantity || !tradeForm.price}
                onClick={submitTrade}>
                {tradeSaving ? <span className="spin" /> : "录入交易"}
              </button>
            </div>
            <p className="helper-text">
              交易流水用于现金流和预算占用核对，不会改写外部净投入，也不会覆盖月结单或人工确认的账面成本。
            </p>

            {trades.length > 0 && (
              <div className="table-scroll data-trades-scroll" tabIndex={0} aria-label="交易流水，可横向滚动">
                <table className="table">
                  <thead>
                    <tr>
                      <th>日期</th>
                      <th>标的</th>
                      <th>方向</th>
                      <th className="num">数量</th>
                      <th className="num">成交价</th>
                      <th className="num">手续费</th>
                      <th className="num">净额</th>
                      <th>原因</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map((t) => (
                      <tr key={t.id}>
                        <td>{t.tradeDate}</td>
                        <td>
                          <b>{t.symbol}</b>
                          <span style={{ color: "var(--ink-4)", fontSize: 11, marginLeft: 6 }}>{t.broker}</span>
                        </td>
                        <td>
                          <span className={`chip ${t.side === "buy" ? "ok" : "warn"}`}>{t.side === "buy" ? "买入" : "卖出"}</span>
                        </td>
                        <td className="num">{fmtMoney(t.quantity, 0)}</td>
                        <td className="num">{fmtMoney(t.price)} {t.currency}</td>
                        <td className="num">{fmtMoney(t.fee)}</td>
                        <td className={`num ${t.side === "buy" ? "" : "pos"}`}>
                          {t.side === "buy" ? "-" : "+"}{fmtMoney(t.quantity * t.price + (t.side === "buy" ? t.fee : -t.fee))} {t.currency}
                        </td>
                        <td style={{ maxWidth: 180, fontSize: 12, color: "var(--ink-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.reason ?? undefined}>
                          {t.reason ?? "—"}
                        </td>
                        <td>
                          <button className="btn danger sm" aria-label={`删除 ${t.tradeDate} ${t.symbol} 交易`} onClick={() => removeTrade(t.id)}>删除</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : (
          <div id="entry-panel-statement" className="fade-in" role="tabpanel" aria-labelledby="entry-tab-statement">
            <div className="steps">
              <div className={`step ${step > 1 ? "done" : "active"}`}>1. 选择券商</div>
              <div className={`step ${step === 2 ? "active" : step > 2 ? "done" : ""}`}>2. 上传并解析</div>
              <div className={`step ${step === 3 ? "active" : ""}`}>3. 预览确认</div>
            </div>

            <div className="broker-grid" style={{ marginBottom: 16 }}>
              {BROKERS.map((b) => (
                <button type="button" key={b.id} className={`broker-item ${broker === b.id ? "active" : ""}`}
                  aria-pressed={broker === b.id}
                  onClick={() => { setBroker(b.id); resetWizard(); }}>
                  <div className="name">{b.label}</div>
                  <div className="hint">{b.hint}</div>
                </button>
              ))}
            </div>

            {broker && (
              <>
                <div className={`dropzone ${drag ? "drag" : ""}`} role="button" tabIndex={0}
                  aria-label={`选择或拖入 ${brokerMeta?.label ?? "券商"} 月结单`}
                  onClick={() => fileInput.current?.click()}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.current?.click(); } }}
                  onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
                  onDragLeave={() => setDrag(false)}
                  onDrop={(e) => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); }}>
                  {files.length === 0 ? (
                    <>点击或拖入 {brokerMeta?.label} 月结单（{brokerMeta?.accept}），可多选</>
                  ) : (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
                      {files.map((f) => (
                        <span key={f.name} className="chip gray">
                          {f.name}
                          <button type="button" className="btn danger sm" aria-label={`移除 ${f.name}`} style={{ padding: "0 4px", marginLeft: 4 }}
                            onClick={(e) => {
                              e.stopPropagation();
                              setPreview(null);
                              setFiles((prev) => prev.filter((x) => x.name !== f.name));
                            }}>
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <input ref={fileInput} type="file" accept={brokerMeta?.accept} multiple hidden
                    onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
                </div>

                <div style={{ display: "flex", gap: 10, marginTop: 14, alignItems: "center", flexWrap: "wrap" }}>
                  {brokerMeta?.needsPassword && (
                    <div className="field password-field">
                      <label htmlFor="statement-password">PDF 密码</label>
                      <input id="statement-password" className="input" type="password"
                        placeholder="仅在浏览器本地使用" value={password}
                        onChange={(e) => setPassword(e.target.value)} />
                    </div>
                  )}
                  <button className="btn" disabled={parsing || files.length === 0} onClick={parse}>
                    {parsing ? (<><span className="spin" /> 本地解析中…</>) : ("本地解析")}
                  </button>
                  {files.length > 0 && (
                    <button className="btn ghost" onClick={resetWizard}>重置</button>
                  )}
                </div>
              </>
            )}

            {preview && (
              <div className="fade-in" style={{ marginTop: 20, borderTop: "1px dashed var(--border)", paddingTop: 18 }}>
                {preview.issues.length > 0 && (
                  <div className="alert warn" role="status">
                    {preview.issues.map((issue) => (
                      <div key={issue.title}><b>{issue.title}</b>：{issue.detail}</div>
                    ))}
                  </div>
                )}
                {unresolvedTransferCount > 0 && (
                  <div className="alert warn" role="status">
                    {unresolvedTransferCount} 条转仓尚未确认数量与单位成本；这不会阻止保存快照，但本次会跳过这些转仓的资本入账。
                  </div>
                )}
                <div className="import-summary-grid" aria-label="待导入结构化数据摘要">
                  <div><span>持仓</span><b>{preview.positions.length}</b></div>
                  <div><span>交易活动</span><b>{preview.tradeActivities.length}</b></div>
                  <div><span>已实现盈亏</span><b>{preview.realizedTrades.length}</b></div>
                  <div><span>股息</span><b>{preview.dividends.length}</b></div>
                </div>
                {preview.tradeActivities.some((activity) => activity.side === "transfer_in" || activity.side === "transfer_out") && (
                  <div className="transfer-confirm-card">
                    <div className="card-h">转仓资本确认<span className="tag">数量 × 确认成本</span></div>
                    <p className="helper-text">转仓不会使用当日市价。只有逐条确认后，才会改变外部净投入。</p>
                    {preview.tradeActivities.map((activity, index) => {
                      if (activity.side !== "transfer_in" && activity.side !== "transfer_out") return null;
                      const confirmed = preview.confirmedTransfers.includes(activity.id);
                      return (
                        <div className="transfer-confirm-row" key={activity.id}>
                          <div><b>{activity.symbol}</b><span>{activity.side === "transfer_in" ? "转入" : "转出"} · {fmtMoney(activity.quantity, 0)} 股</span></div>
                          <div className="transfer-confirm-field">
                            <label htmlFor={`transfer-quantity-${index}`}>确认数量</label>
                            <input
                              id={`transfer-quantity-${index}`}
                              className="input sm"
                              type="number"
                              min="0"
                              value={activity.quantity}
                              onChange={(event) => {
                                const next = [...preview.tradeActivities];
                                const quantity = Number(event.target.value);
                                next[index] = {
                                  ...activity,
                                  quantity,
                                  amount: activity.unitPrice == null ? activity.amount : quantity * activity.unitPrice,
                                };
                                setPreview({
                                  ...preview,
                                  tradeActivities: next,
                                  confirmedTransfers: preview.confirmedTransfers.filter((id) => id !== activity.id),
                                });
                              }}
                            />
                          </div>
                          <div className="transfer-confirm-field">
                            <label htmlFor={`transfer-cost-${index}`}>确认单位成本</label>
                            <input
                              id={`transfer-cost-${index}`}
                              className="input sm"
                              type="number"
                              min="0"
                              value={activity.unitPrice ?? ""}
                              onChange={(event) => {
                                const next = [...preview.tradeActivities];
                                const unitPrice = event.target.value === "" ? undefined : Number(event.target.value);
                                next[index] = { ...activity, unitPrice, amount: unitPrice == null ? activity.amount : activity.quantity * unitPrice };
                                setPreview({
                                  ...preview,
                                  tradeActivities: next,
                                  confirmedTransfers: preview.confirmedTransfers.filter((id) => id !== activity.id),
                                });
                              }}
                            />
                          </div>
                          <span>{activity.currency} · 资本额 {activity.unitPrice == null ? "待确认" : fmtMoney(activity.quantity * activity.unitPrice)}</span>
                          <label className="check-field"><input type="checkbox" disabled={!(activity.quantity > 0) || !activity.unitPrice || activity.unitPrice <= 0} checked={confirmed} onChange={(event) => setPreview({ ...preview, confirmedTransfers: event.target.checked ? [...preview.confirmedTransfers, activity.id] : preview.confirmedTransfers.filter((id) => id !== activity.id) })} />确认数量与成本</label>
                        </div>
                      );
                    })}
                  </div>
                )}
                <div style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
                  <div className="card-h" style={{ margin: 0 }}>持仓预览（{preview.positions.length} 条）</div>
                  <label style={{ fontSize: 12, color: "var(--ink-3)" }}>
                    快照日期
                    <input className="input sm" style={{ width: 130, marginLeft: 6 }} type="date" value={preview.asOf}
                      onChange={(e) => setPreview({ ...preview, asOf: e.target.value })} />
                  </label>
                </div>
                <div className="table-scroll preview-table-scroll" tabIndex={0} aria-label="持仓预览，可横向滚动">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>标的</th><th>市场</th><th>币种</th>
                        <th className="num">数量</th><th className="num">市值</th><th className="num">成本</th><th />
                      </tr>
                    </thead>
                    <tbody>
                      {preview.positions.map((p, i) => (
                        <tr key={`${p.symbol}-${i}`}>
                          <td>
                            <b>{p.symbol}</b>
                            <span style={{ color: "var(--ink-4)", fontSize: 11, marginLeft: 6 }}>{p.name}</span>
                          </td>
                          <td>{p.market}</td>
                          <td>{p.currency}</td>
                          <td className="num">{fmtMoney(p.quantity, 0)}</td>
                          <td className="num">
                            <input aria-label={`${p.symbol} 市值`} className="input sm num" style={{ width: 110, textAlign: "right" }} type="number"
                              value={p.marketValue}
                              onChange={(e) => {
                                const next = [...preview.positions];
                                next[i] = { ...p, marketValue: Number(e.target.value) };
                                setPreview({ ...preview, positions: next });
                              }} />
                          </td>
                          <td className="num">{p.costBasis != null ? fmtMoney(p.costBasis) : "—"}</td>
                          <td>
                            <button className="btn danger sm" aria-label={`删除 ${p.symbol} 持仓预览`}
                              onClick={() => setPreview({ ...preview, positions: preview.positions.filter((_, j) => j !== i) })}>
                              删除
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="card-h">
                  现金余额
                  {preview.cash.some((c) => !c.fromParse) && (
                    <span className="chip warn">未能从月结单自动提取，请手动填写</span>
                  )}
                </div>
                <div className="cash-preview-list">
                  {preview.cash.map((c, i) => (
                    <div key={i} className="cash-preview-row">
                      <label className="sr-only" htmlFor={`cash-preview-currency-${i}`}>现金币种</label>
                      <select id={`cash-preview-currency-${i}`} className="select" value={c.currency}
                        onChange={(e) => {
                          const next = [...preview.cash];
                          next[i] = { ...c, currency: e.target.value };
                          setPreview({ ...preview, cash: next });
                        }}>
                        <option>USD</option><option>HKD</option><option>CNY</option>
                      </select>
                      <label className="sr-only" htmlFor={`cash-preview-amount-${i}`}>{c.currency} 现金金额</label>
                      <input id={`cash-preview-amount-${i}`} className="input sm" type="number" placeholder="金额" value={c.amount}
                        onChange={(e) => {
                          const next = [...preview.cash];
                          next[i] = { ...c, amount: e.target.value };
                          setPreview({ ...preview, cash: next });
                        }} />
                      <span className={`chip ${c.fromParse ? "ok" : "gray"}`}>{c.fromParse ? "自动提取" : "手动"}</span>
                      <button className="btn danger sm" aria-label={`删除 ${c.currency} 现金余额`}
                        onClick={() => setPreview({ ...preview, cash: preview.cash.filter((_, j) => j !== i) })}>
                        删除
                      </button>
                    </div>
                  ))}
                  <button className="btn ghost sm cash-preview-add"
                    onClick={() => setPreview({ ...preview, cash: [...preview.cash, { currency: "USD", amount: "", fromParse: false }] })}>
                    + 添加币种
                  </button>
                </div>

                <button className="btn" disabled={saving} onClick={save}>
                  {saving ? <span className="spin" /> : `确认保存快照（${brokerMeta?.label} @ ${preview.asOf}）`}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-h">历史快照</div>
        {statements.length === 0 ? (
          <div className="empty">还没有保存过快照</div>
        ) : (
          <div className="table-scroll" tabIndex={0} aria-label="历史快照，可横向滚动">
          <table className="table">
            <thead>
              <tr>
                <th>券商</th><th>快照日期</th><th>文件</th>
                <th className="num">持仓数</th><th className="num">现金记录</th><th>上传时间</th><th />
              </tr>
            </thead>
            <tbody>
              {statements.map((s) => (
                <tr key={s.id}>
                  <td><b>{BROKERS.find((b) => b.id === s.broker)?.label ?? s.broker}</b></td>
                  <td>{s.asOf}</td>
                  <td style={{ maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.fileName}</td>
                  <td className="num">{s.positionCount}</td>
                  <td className="num">{s.cashCount}</td>
                  <td style={{ color: "var(--ink-4)", fontSize: 12 }}>{s.uploadedAt}</td>
                  <td>
                    <button className="btn danger sm" aria-label={`删除 ${s.broker} ${s.asOf} 快照`} onClick={() => removeStatement(s.id)}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}
