import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import { fmtMoney } from "../components/Chart";
import { describeCoverageItems } from "../lib/portfolio/coverage";
import { aggregateSummaryPositions, type InstrumentPosition } from "../lib/portfolio/positions";
import { BUCKET_LABELS, type Bucket, type Coverage, type Summary } from "../types";

const COST_SOURCE_LABEL: Record<string, string> = {
  manual: "人工确认",
  statement: "月结单",
  trades: "待核对流水",
  none: "待补录",
  mixed: "多券商来源",
};

type SortKey = "holding" | "pnl" | "symbol";

function moneyOrDash(value: number | null | undefined, prefix = "$") {
  return value == null ? "—" : `${value >= 0 ? "+" : ""}${prefix}${fmtMoney(value)}`;
}

function coverageLabel(coverage?: Coverage) {
  if (!coverage) return { text: "旧口径", className: "gray" };
  if (coverage.status === "complete") return { text: "完整", className: "ok" };
  if (coverage.status === "partial") return { text: "部分数据", className: "warn" };
  return { text: "待补录", className: "warn" };
}

export default function HoldingsPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [bucketFilter, setBucketFilter] = useState("");
  const [qualityOnly, setQualityOnly] = useState(false);
  const [sort, setSort] = useState<SortKey>("holding");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editingCost, setEditingCost] = useState<{ key: string; value: string } | null>(null);
  // 分层视图：默认只看自主组合，授予仓（RSU）单独隔离
  const [scope, setScope] = useState<"self" | "all">("self");
  // 持有时长（自首次买入日）：来自交易流水，无买入记录的持仓显示 —
  const [holdingAges, setHoldingAges] = useState<Map<string, { firstBuyDate: string; days: number }>>(new Map());

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const [nextSummary, stats] = await Promise.all([
        api.get<Summary>(`/api/portfolio/summary?display=USD${scope === "self" ? "&scope=self" : ""}`),
        api.get<{ openHoldingAges: Array<{ key: string; firstBuyDate: string; days: number }> }>("/api/trades/closed-stats"),
      ]);
      setSummary(nextSummary);
      setHoldingAges(new Map(stats.openHoldingAges.map((h) => [h.key, { firstBuyDate: h.firstBuyDate, days: h.days }])));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "持仓加载失败");
    } finally {
      setBusy(false);
    }
  }, [scope]);

  useEffect(() => {
    void load();
  }, [load]);

  const setBucket = async (market: string, symbol: string, bucket: string) => {
    try {
      await api.put("/api/buckets", { market, symbol, bucket: bucket === "unassigned" ? null : (bucket as Bucket) });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "仓别保存失败");
    }
  };

  /** 按每股成本录入，保存时换算为总成本（后端口径）；清空则恢复券商快照成本。 */
  const saveCost = async (broker: string, symbol: string, raw: string, quantity: number) => {
    const value = raw.trim();
    const perShare = value === "" ? null : Number(value);
    if (perShare != null && (!Number.isFinite(perShare) || perShare < 0)) {
      setError("每股成本需为非负数字，清空可恢复月结单口径");
      return;
    }
    const total = perShare == null ? null : quantity > 0 ? Math.round(perShare * quantity * 10000) / 10000 : perShare;
    try {
      await api.put("/api/positions/cost", { broker, symbol, costBasis: total });
      setEditingCost(null);
      setNotice(value === "" ? "已恢复券商快照成本口径" : `${symbol} · ${broker} 成本已按 ${perShare}/股 更新（共 ${total}）`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "成本保存失败");
    }
  };

  const instruments = useMemo(
    () => aggregateSummaryPositions(summary?.positions ?? [], summary?.kpi.positionsValue ?? 0, summary?.instruments),
    [summary],
  );
  const positions = useMemo(() => {
    const filtered = instruments.filter((position) => {
      if (bucketFilter && position.bucket !== bucketFilter) return false;
      if (qualityOnly && position.coverage.status === "complete") return false;
      return true;
    });
    return [...filtered].sort((a, b) => {
      if (sort === "symbol") return a.symbol.localeCompare(b.symbol);
      if (sort === "pnl") return (b.pnl.explainedTotal ?? -Infinity) - (a.pnl.explainedTotal ?? -Infinity);
      return b.holdingRatio - a.holdingRatio;
    });
  }, [instruments, bucketFilter, qualityOnly, sort]);

  const totalBookCost = summary?.costs?.bookCost ?? summary?.kpi.totalCost ?? null;
  const externalNetInvested = summary?.costs?.externalNetInvested ?? null;
  const missingCount = instruments.filter((position) => position.coverage.status !== "complete").length;

  if (busy) return <div className="empty"><span className="spin dark" aria-label="正在加载持仓" /></div>;

  return (
    <div className="fade-in">
      <div className="page-heading-row">
        <div>
          <h1 className="page-title">持仓分析</h1>
          <p className="page-desc">按市场与标的聚合仓位、账面成本和盈亏；券商明细可展开核对。</p>
        </div>
        <div className="heading-actions">
          <div className="scope-toggle" role="tablist" aria-label="持仓视图范围">
            <button role="tab" aria-selected={scope === "self"} className={scope === "self" ? "active" : ""} onClick={() => setScope("self")}>自主组合</button>
            <button role="tab" aria-selected={scope === "all"} className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>全部资产</button>
          </div>
          <Link className="btn ghost" to="/data">补录数据</Link>
        </div>
      </div>

      {scope === "self" && (summary?.grant?.count ?? 0) > 0 && (
        <div className="alert warn" role="status">
          已隔离授予仓（RSU）：{summary?.grant?.symbols.join("、")} · ${fmtMoney(summary?.grant?.valueDisplay ?? 0, 0)}，不计入下方分布与集中度；切换到“全部资产”可查看。
        </div>
      )}

      {error && <div className="alert error" role="alert">{error}</div>}
      {notice && <div className="alert ok" role="status">{notice}</div>}
      {summary?.coverage && summary.coverage.status !== "complete" && (
        <div className="alert warn coverage-alert">
          <div><b>当前为部分数据</b>：未知金额不会按 0 计入盈亏。</div>
          <div>{describeCoverageItems([...summary.coverage.issues, ...summary.coverage.missing]).join("；")}</div>
          <Link to="/data">前往数据管理补齐</Link>
        </div>
      )}

      <section className="grid grid-4 holdings-kpis" aria-label="持仓核心指标">
        <div className="kpi ok"><div className="k">持仓市值</div><div className="v">${fmtMoney(summary?.kpi.positionsValue ?? 0, 0)}</div><div className="sub">{instruments.length} 个标的</div></div>
        <div className="kpi violet"><div className="k">账面成本</div><div className="v">{totalBookCost == null ? "—" : `$${fmtMoney(totalBookCost, 0)}`}</div><div className="sub">当前剩余股份 · USD</div></div>
        <div className="kpi blue"><div className="k">外部净投入</div><div className="v">{externalNetInvested == null ? "待初始化" : `$${fmtMoney(externalNetInvested, 0)}`}</div><div className="sub">不会随内部买卖重复累计</div></div>
        <div className="kpi accent"><div className="k">数据缺口</div><div className="v">{missingCount}</div><div className="sub">缺成本或收益流水的标的</div></div>
      </section>

      <section className="card section-card" aria-labelledby="positions-title">
        <div className="card-h" id="positions-title">单股成本与盈亏<span className="tag">按 market:symbol 聚合 · USD</span></div>
        <div className="filter-row holdings-filter">
          <div className="field"><label htmlFor="holding-bucket-filter">仓别</label><select id="holding-bucket-filter" className="select" value={bucketFilter} onChange={(event) => setBucketFilter(event.target.value)}><option value="">全部仓别</option>{Object.entries(BUCKET_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
          <div className="field"><label htmlFor="holding-sort">排序</label><select id="holding-sort" className="select" value={sort} onChange={(event) => setSort(event.target.value as SortKey)}><option value="holding">持仓占比</option><option value="pnl">累计盈亏</option><option value="symbol">标的代码</option></select></div>
          <label className="check-field"><input type="checkbox" checked={qualityOnly} onChange={(event) => setQualityOnly(event.target.checked)} />只看待补录</label>
        </div>

        {positions.length === 0 ? (
          <div className="empty">没有符合条件的持仓</div>
        ) : (
          <div className="table-scroll holdings-table-wrap" tabIndex={0} aria-label="持仓表，可横向滚动">
            <table className="table holdings-table">
              <thead><tr><th>标的 / 行情</th><th>仓别</th><th className="num">市值 / 占比</th><th className="num">账面成本</th><th className="num">资本利得</th><th className="num">股息</th><th className="num">交易费用</th><th className="num">累计盈亏</th><th className="num">持有时长</th><th>数据</th><th /></tr></thead>
              <tbody>
                {positions.map((position) => {
                  const detailId = `detail-${position.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
                  const coverage = coverageLabel(position.coverage);
                  return (
                    <Fragment key={position.key}>
                      <tr>
                        <td><b>{position.symbol}</b><span className="position-name">{position.name}</span><span className="position-quote">{position.currentPrice == null ? "行情待更新" : `${fmtMoney(position.currentPrice)} ${position.currency}`}{position.quoteApplied ? " · 最新" : ""} · {position.brokerRows.length} 个券商账户</span></td>
                        <td><select aria-label={`${position.symbol} 仓别`} className="select compact-select" value={position.bucket} onChange={(event) => setBucket(position.market, position.symbol, event.target.value)}>{Object.entries(BUCKET_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></td>
                        <td className="num"><b>${fmtMoney(position.valueDisplay, 0)}</b><span className="cell-sub">{(position.holdingRatio * 100).toFixed(1)}% 持仓内</span></td>
                        <td className="num">
                          {position.avgCost != null
                            ? <b>{fmtMoney(position.avgCost)} {position.currency}/股</b>
                            : position.bookCostDisplay == null ? "待补录" : `$${fmtMoney(position.bookCostDisplay)}`}
                          {position.avgCost != null && position.bookCostDisplay != null && <span className="cell-sub">共 ${fmtMoney(position.bookCostDisplay)}</span>}
                          <span className={`chip ${position.bookCostDisplay == null ? "warn" : "gray"}`}>{COST_SOURCE_LABEL[position.costSource] ?? position.costSource}</span>
                        </td>
                        <td className={`num ${(position.pnl.capitalGain ?? 0) >= 0 ? "pos" : "neg"}`}>{moneyOrDash(position.pnl.capitalGain)}</td>
                        <td className="num pos">{moneyOrDash(position.pnl.dividendsNet)}</td>
                        <td className="num neg">{position.pnl.tradingFees ? `-$${fmtMoney(Math.abs(position.pnl.tradingFees))}` : "$0.00"}</td>
                        <td className={`num ${(position.pnl.explainedTotal ?? 0) >= 0 ? "pos" : "neg"}`}><b>{moneyOrDash(position.pnl.explainedTotal)}</b></td>
                        <td className="num">
                          {(() => {
                            const age = holdingAges.get(position.key);
                            if (!age) return "—";
                            return <><b>{age.days} 天</b><span className="cell-sub">自 {age.firstBuyDate}</span></>;
                          })()}
                        </td>
                        <td><span className={`chip ${coverage.className}`}>{coverage.text}</span></td>
                        <td><button className="btn ghost sm" aria-expanded={expanded === position.key} aria-controls={detailId} onClick={() => setExpanded(expanded === position.key ? null : position.key)}>{expanded === position.key ? "收起" : "详情"}</button></td>
                      </tr>
                      {expanded === position.key && <InstrumentDetail position={position} detailId={detailId} editingCost={editingCost} setEditingCost={setEditingCost} saveCost={saveCost} />}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function InstrumentDetail({
  position,
  detailId,
  editingCost,
  setEditingCost,
  saveCost,
}: {
  position: InstrumentPosition;
  detailId: string;
  editingCost: { key: string; value: string } | null;
  setEditingCost: (value: { key: string; value: string } | null) => void;
  saveCost: (broker: string, symbol: string, raw: string, quantity: number) => Promise<void>;
}) {
  return (
    <tr id={detailId} className="position-detail-row">
      <td colSpan={11}>
        <div className="position-detail-grid">
          <div><span>聚合数量</span><b>{fmtMoney(position.quantity, 0)} 股</b></div>
          <div><span>当前平均账面成本</span><b>{position.avgCost == null ? "待补录" : `${fmtMoney(position.avgCost)} ${position.currency}`}</b></div>
          <div><span>未实现 / 已实现资本利得</span><b>{moneyOrDash(position.pnl.unrealizedCapitalGain)} · {moneyOrDash(position.pnl.realizedCapitalGain)}</b></div>
          <div><span>标的关联净投入</span><b>{position.externalNetInvested == null ? "待确认转仓成本" : position.externalNetInvested === 0 ? "无（场内买入）" : `$${fmtMoney(position.externalNetInvested)}`}</b></div>
          <div><span>可归属融资费用</span><b>{position.pnl.financingFees ? `-$${fmtMoney(Math.abs(position.pnl.financingFees))}` : "$0.00"}</b></div>
        </div>
        <p className="helper-text">成本按“每股成本”录入，保存时自动按数量换算为总成本；清空保存可恢复券商快照口径。无法明确归属标的的融资费用只在资产总览体现，不在这里推测性摊派。</p>
        {(position.coverage.issues.length > 0 || position.coverage.missing.length > 0) && <p className="data-issues">待补录：{describeCoverageItems([...position.coverage.issues, ...position.coverage.missing]).join("；")}</p>}
        <div className="table-scroll broker-position-scroll" tabIndex={0} aria-label={`${position.symbol} 券商明细，可横向滚动`}>
          <table className="table broker-position-table">
            <thead><tr><th>券商</th><th>数据日期</th><th className="num">数量</th><th className="num">市值 USD</th><th className="num">券商账面成本</th><th>成本来源</th><th /></tr></thead>
            <tbody>{position.brokerRows.map((row) => {
              const editKey = `${row.broker}|${row.market}|${row.symbol}`;
              const rowCost = row.bookCost ?? row.effectiveCost;
              const editing = editingCost?.key === editKey;
              return (
                <tr key={editKey}>
                  <td><b>{row.broker}</b></td><td>{row.asOf}</td><td className="num">{fmtMoney(row.quantity, 0)}</td><td className="num">${fmtMoney(row.valueDisplay)}</td>
                  <td className="num">{editing ? <input aria-label={`${row.broker} ${row.symbol} 每股成本`} className="input sm cost-input" type="number" min="0" step="any" placeholder="每股成本" autoFocus value={editingCost.value} onChange={(event) => setEditingCost({ key: editKey, value: event.target.value })} /> : rowCost == null ? "待补录" : <>{row.quantity > 0 ? `${fmtMoney(rowCost / row.quantity)} ${row.currency}/股` : `${fmtMoney(rowCost)} ${row.currency}`}<span className="cell-sub">共 {fmtMoney(rowCost)} {row.currency}</span></>}</td>
                  <td><span className={`chip ${rowCost == null ? "warn" : "gray"}`}>{COST_SOURCE_LABEL[row.bookCostSource ?? row.costSource] ?? row.costSource}</span></td>
                  <td>{editing ? <div className="inline-actions"><button className="btn sm" onClick={() => void saveCost(row.broker, row.symbol, editingCost.value, row.quantity)}>保存</button><button className="btn ghost sm" onClick={() => setEditingCost(null)}>取消</button></div> : <button className="btn ghost sm" onClick={() => setEditingCost({ key: editKey, value: rowCost == null || !(row.quantity > 0) ? "" : String(Math.round((rowCost / row.quantity) * 10000) / 10000) })}>修改成本</button>}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      </td>
    </tr>
  );
}
