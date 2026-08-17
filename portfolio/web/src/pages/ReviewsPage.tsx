import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import { fmtMoney } from "../components/Chart";
import type { Currency, ReviewListItem, ReviewResponse } from "../types";

const CCY_SIGN: Record<Currency, string> = { USD: "$", HKD: "HK$", CNY: "¥" };

function pctText(value: number | null | undefined, digits = 2) {
  return value == null ? "—" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`;
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

/** 生成从起始月到当前月的倒序月份列表（供选择器用，最多 24 个）。 */
function recentMonths(count = 24): string[] {
  const list: string[] = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth() - i, 1));
    list.push(d.toISOString().slice(0, 7));
  }
  return list;
}

const DISCIPLINE_LABELS: Record<string, string> = {
  stable_dca: "稳健仓定投执行",
  cash_floor: "现金底线",
};

export default function ReviewsPage() {
  const [display, setDisplay] = useState<Currency>("USD");
  const [month, setMonth] = useState(currentMonth());
  const [review, setReview] = useState<ReviewResponse | null>(null);
  const [reviewed, setReviewed] = useState<ReviewListItem[]>([]);
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState({ attribution: "", mistakes: "", improvements: "", macroNote: "" });

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const [detail, list] = await Promise.all([
        api.get<ReviewResponse>(`/api/reviews/${month}?display=${display}`),
        api.get<ReviewListItem[]>("/api/reviews"),
      ]);
      setReview(detail);
      setReviewed(list);
      setForm({
        attribution: detail.manual.attribution,
        mistakes: detail.manual.mistakes,
        improvements: detail.manual.improvements,
        macroNote: detail.manual.macroNote,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "复盘数据加载失败");
    } finally {
      setBusy(false);
    }
  }, [month, display]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await api.put(`/api/reviews/${month}`, form);
      setNotice(`已保存 ${month} 复盘`);
      setReviewed(await api.get<ReviewListItem[]>("/api/reviews"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const sign = CCY_SIGN[display];
  const auto = review?.auto ?? null;
  const monthOptions = useMemo(() => {
    const set = new Set([...recentMonths(), ...reviewed.map((r) => r.month)]);
    return Array.from(set).sort().reverse();
  }, [reviewed]);
  const reviewedSet = useMemo(() => new Set(reviewed.map((r) => r.month)), [reviewed]);

  if (busy) return <div className="empty"><span className="spin dark" /></div>;

  return (
    <div className="fade-in">
      <div className="page-heading-row">
        <div>
          <h1 className="page-title">月度复盘</h1>
          <p className="page-desc">核心数据自动生成；归因、错误与改进手动沉淀，形成可回看的决策档案。</p>
        </div>
        <div className="heading-actions">
          <label className="sr-only" htmlFor="review-month">复盘月份</label>
          <select id="review-month" className="select" value={month} onChange={(e) => setMonth(e.target.value)}>
            {monthOptions.map((m) => (
              <option key={m} value={m}>{m}{reviewedSet.has(m) ? " ✓" : ""}</option>
            ))}
          </select>
          <label className="sr-only" htmlFor="review-currency">展示币种</label>
          <select id="review-currency" className="select currency-select" value={display} onChange={(e) => setDisplay(e.target.value as Currency)}>
            <option value="USD">USD 计价</option>
            <option value="HKD">HKD 计价</option>
            <option value="CNY">CNY 计价</option>
          </select>
        </div>
      </div>

      {error && <div className="alert error" role="alert">{error}</div>}
      {notice && <div className="alert ok" role="status">{notice}</div>}

      {auto == null ? (
        <div className="card empty">该月份没有可计算的净值数据（缺月结单快照），仅可填写手工复盘。</div>
      ) : (
        <>
          <section className="summary-primary-grid" aria-label="当月核心数据">
            <div className="kpi"><div className="k">月末总资产</div><div className="v">{sign}{fmtMoney(auto.endAssetsDisplay, 0)}</div><div className="sub">月初 {auto.startAssetsDisplay == null ? "—" : `${sign}${fmtMoney(auto.startAssetsDisplay, 0)}`}</div></div>
            <div className="kpi ok"><div className="k">当月投资盈亏</div><div className={`v ${(auto.pnlDisplay ?? 0) >= 0 ? "" : "neg"}`}>{auto.pnlDisplay == null ? "—" : `${auto.pnlDisplay >= 0 ? "+" : "-"}${sign}${fmtMoney(Math.abs(auto.pnlDisplay), 0)}`}</div><div className="sub">已剔除出入金 {sign}{fmtMoney(Math.abs(auto.flowDisplay), 0)}</div></div>
            <div className="kpi violet"><div className="k">月度收益率</div><div className="v">{pctText(auto.monthlyReturn)}</div><div className="sub">单位净值环比</div></div>
            <div className="kpi blue"><div className="k">截至当月最大回撤</div><div className="v">{pctText(auto.maxDrawdownToDate)}</div><div className="sub">自净值起点累计</div></div>
            <div className="kpi accent"><div className="k">当月手续费</div><div className="v">{sign}{fmtMoney(auto.feesDisplay, 0)}</div><div className="sub">{auto.closedCount} 笔平仓</div></div>
          </section>

          <section className="card section-card">
            <div className="card-h">纪律审计<span className="tag">规则执行核对 · 非主观评分</span></div>
            <div className="constraint-list">
              {auto.discipline.map((item) => (
                <div key={item.key} className="constraint-row">
                  <div>
                    <span>{DISCIPLINE_LABELS[item.key] ?? item.key}</span>
                    <b className={item.ok ? "pos" : "neg"}>{item.ok ? "✓ 达标" : "✗ 未达标"}</b>
                  </div>
                  <small>{item.note}</small>
                </div>
              ))}
            </div>
          </section>

          <div className="grid grid-2">
            <section className="card">
              <div className="card-h">盈利 TOP3<span className="tag">当月平仓</span></div>
              {auto.topWins.length === 0 ? <div className="empty">本月无盈利平仓</div> : (
                <table className="table">
                  <thead><tr><th>标的</th><th className="num">盈亏</th><th>原因</th></tr></thead>
                  <tbody>
                    {auto.topWins.map((t) => (
                      <tr key={t.id}><td><b>{t.symbol}</b><span className="cell-sub">{t.tradeDate}</span></td><td className="num pos">+{sign}{fmtMoney(t.pnlDisplay, 0)}</td><td style={{ fontSize: 12 }}>{t.reason ?? "—"}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
            <section className="card">
              <div className="card-h">亏损 TOP3<span className="tag">当月平仓</span></div>
              {auto.topLosses.length === 0 ? <div className="empty">本月无亏损平仓</div> : (
                <table className="table">
                  <thead><tr><th>标的</th><th className="num">盈亏</th><th>原因</th></tr></thead>
                  <tbody>
                    {auto.topLosses.map((t) => (
                      <tr key={t.id}><td><b>{t.symbol}</b><span className="cell-sub">{t.tradeDate}</span></td><td className="num neg">-{sign}{fmtMoney(Math.abs(t.pnlDisplay), 0)}</td><td style={{ fontSize: 12 }}>{t.reason ?? "—"}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>
        </>
      )}

      <section className="card section-card">
        <div className="card-h">复盘手记<span className="tag">{review?.manual.updatedAt ? `上次保存 ${review.manual.updatedAt}` : "尚未保存"}</span></div>
        <div className="grid grid-2">
          <div className="field">
            <label htmlFor="review-attribution">归因分析（涨跌因何而来）</label>
            <textarea id="review-attribution" className="input" rows={4} value={form.attribution} onChange={(e) => setForm({ ...form, attribution: e.target.value })} placeholder="如：宽指定投贡献为主，个股 MSFT 拖累……" />
          </div>
          <div className="field">
            <label htmlFor="review-mistakes">本月典型错误</label>
            <textarea id="review-mistakes" className="input" rows={4} value={form.mistakes} onChange={(e) => setForm({ ...form, mistakes: e.target.value })} placeholder="如：大涨日追高、未按计划定投……" />
          </div>
          <div className="field">
            <label htmlFor="review-improvements">改进措施</label>
            <textarea id="review-improvements" className="input" rows={4} value={form.improvements} onChange={(e) => setForm({ ...form, improvements: e.target.value })} placeholder="如：下月严格限价单、复核阶梯触发价……" />
          </div>
          <div className="field">
            <label htmlFor="review-macro">宏观环境备忘</label>
            <textarea id="review-macro" className="input" rows={4} value={form.macroNote} onChange={(e) => setForm({ ...form, macroNote: e.target.value })} placeholder="如：美联储议息、财报季走向……" />
          </div>
        </div>
        <button className="btn" disabled={saving} onClick={save}>{saving ? <span className="spin" /> : `保存 ${month} 复盘`}</button>
      </section>
    </div>
  );
}
