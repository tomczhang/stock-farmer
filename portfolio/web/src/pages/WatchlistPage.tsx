import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { fmtMoney } from "../components/Chart";
import { ValueFlash } from "../components/ValueFlash";
import type { WatchlistItem } from "../types";

interface AddForm {
  market: string;
  symbol: string;
  name: string;
  note: string;
  refHigh: string;
}

const EMPTY_FORM: AddForm = { market: "US", symbol: "", name: "", note: "", refHigh: "" };

/** 回撤越深颜色越醒目。 */
function drawdownClass(value: number | null) {
  if (value == null) return "";
  if (value <= -0.17) return "neg";
  if (value <= -0.1) return "warn-text";
  return "";
}

export default function WatchlistPage() {
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [form, setForm] = useState<AddForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<{ id: number; note: string; refHigh: string } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setItems(await api.get<WatchlistItem[]>("/api/watchlist"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "观察列表加载失败");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load().then(() => refresh(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = async (showNotice = true) => {
    setRefreshing(true);
    setError("");
    try {
      const refreshed = await api.post<WatchlistItem[]>("/api/watchlist/refresh");
      setItems(refreshed);
      if (showNotice) setNotice("报价已刷新，观察高点已按棘轮规则更新");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "报价刷新失败");
    } finally {
      setRefreshing(false);
    }
  };

  const add = async () => {
    setSaving(true);
    setError("");
    try {
      await api.post("/api/watchlist", {
        market: form.market,
        symbol: form.symbol.trim().toUpperCase(),
        name: form.name.trim() || undefined,
        note: form.note.trim() || undefined,
        refHigh: form.refHigh === "" ? undefined : Number(form.refHigh),
      });
      setForm({ ...EMPTY_FORM, market: form.market });
      setNotice(`已加入观察：${form.symbol.toUpperCase()}`);
      await refresh(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "添加失败");
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    try {
      await api.patch(`/api/watchlist/${editing.id}`, {
        note: editing.note,
        refHigh: editing.refHigh === "" ? undefined : Number(editing.refHigh),
      });
      setEditing(null);
      await refresh(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "保存失败");
    }
  };

  const remove = async (item: WatchlistItem) => {
    if (!window.confirm(`确定移除观察标的 ${item.symbol}？`)) return;
    try {
      await api.delete(`/api/watchlist/${item.id}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "删除失败");
    }
  };

  if (busy) return <div className="empty"><span className="spin dark" /></div>;

  return (
    <div className="fade-in">
      <div className="page-heading-row">
        <div>
          <h1 className="page-title">观察窗口</h1>
          <p className="page-desc">跟踪意向标的的现价与高位回撤；观察高点只升不降（棘轮），可手填 52 周高等参考值。</p>
        </div>
        <button className="btn ghost btn-twin" disabled={refreshing || items.length === 0} onClick={() => refresh()}>
          <span className="twin" aria-hidden>刷新报价</span>
          <span className="face">{refreshing ? <span className="spin dark" /> : "刷新报价"}</span>
        </button>
      </div>

      {error && <div className="alert error" role="alert">{error}</div>}
      {notice && <div className="alert ok" role="status">{notice}</div>}

      <section className="card section-card">
        <div className="card-h">添加观察标的<span className="tag">未填高点时以当前报价初始化</span></div>
        <div className="filter-row" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: 12 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="watch-market">市场</label>
            <select id="watch-market" className="select" style={{ width: 90 }} value={form.market} onChange={(e) => setForm({ ...form, market: e.target.value })}>
              <option value="US">美股</option>
              <option value="HK">港股</option>
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="watch-symbol">标的</label>
            <input id="watch-symbol" className="input sm" style={{ width: 110 }} placeholder="VOO / 00700" value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="watch-name">名称（可选）</label>
            <input id="watch-name" className="input sm" style={{ width: 140 }} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="watch-ref-high">观察高点（可选）</label>
            <input id="watch-ref-high" className="input sm" style={{ width: 110 }} type="number" min="0" placeholder="如 52周高" value={form.refHigh} onChange={(e) => setForm({ ...form, refHigh: e.target.value })} />
          </div>
          <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 180 }}>
            <label htmlFor="watch-note">备注（可手填 PE 等估值参考）</label>
            <input id="watch-note" className="input sm" placeholder="如：PE 28 / 96% 分位，等 -15%" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </div>
          <button className="btn sm" style={{ height: 32 }} disabled={saving || !form.symbol.trim()} onClick={add}>{saving ? <span className="spin" /> : "加入观察"}</button>
        </div>
      </section>

      <section className="card section-card">
        <div className="card-h">观察列表<span className="tag">{items.length} 个标的</span></div>
        {items.length === 0 ? (
          <div className="empty">还没有观察标的，先在上方添加</div>
        ) : (
          <div className="table-scroll" tabIndex={0} aria-label="观察列表，可横向滚动">
            <table className="table">
              <thead><tr><th>标的</th><th className="num">现价</th><th className="num">观察高点</th><th className="num">高位回撤</th><th>备注</th><th /></tr></thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td><b>{item.symbol}</b><span className="cell-sub">{item.name} · {item.market}</span></td>
                    <td className="num">{item.price == null ? "—" : <ValueFlash value={item.price}>{fmtMoney(item.price)} {item.currency ?? ""}</ValueFlash>}</td>
                    <td className="num">
                      {editing?.id === item.id ? (
                        <input className="input sm" style={{ width: 100 }} type="number" min="0" value={editing.refHigh} onChange={(e) => setEditing({ ...editing, refHigh: e.target.value })} />
                      ) : item.refHigh == null ? "待报价初始化" : (
                        <><b>{fmtMoney(item.refHigh)}</b>{item.refHighDate && <span className="cell-sub">自 {item.refHighDate} 跟踪</span>}</>
                      )}
                    </td>
                    <td className={`num ${drawdownClass(item.drawdownFromHigh)}`}>
                      {item.drawdownFromHigh == null ? "—" : <b>{(item.drawdownFromHigh * 100).toFixed(1)}%</b>}
                    </td>
                    <td style={{ maxWidth: 240, fontSize: 12 }}>
                      {editing?.id === item.id ? (
                        <input className="input sm" value={editing.note} onChange={(e) => setEditing({ ...editing, note: e.target.value })} />
                      ) : (item.note || "—")}
                    </td>
                    <td>
                      {editing?.id === item.id ? (
                        <>
                          <button className="btn sm" onClick={saveEdit}>保存</button>
                          <button className="btn ghost sm" onClick={() => setEditing(null)}>取消</button>
                        </>
                      ) : (
                        <>
                          <button className="btn ghost sm" onClick={() => setEditing({ id: item.id, note: item.note, refHigh: item.refHigh == null ? "" : String(item.refHigh) })}>编辑</button>
                          <button className="btn danger sm" onClick={() => remove(item)}>移除</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="helper-text">高位回撤 = (现价 − 观察高点) ÷ 观察高点；黄色 ≤ −10%，红色 ≤ −17%（与阶梯档位呼应）。</p>
      </section>
    </div>
  );
}
